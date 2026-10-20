// EDAScout Worker: open dashboard + JSON API, daily scan on cron.
// Viewing, Ask and "Run scan" are open to everyone (rate-limited). Changing sources/models needs the edit key.
import { json, safeUrl, sha256, robotsAllows } from './util.js';
import { runDaily, processSource } from './pipeline.js';
import { chat, clearRouteCache } from './llm.js';
import { trends, METRICS } from './data.js';

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY' };
const GEOS = ['norfolk', 'region', 'state'];
const GEO_SQL = { norfolk: "('norfolk')", region: "('norfolk','region')", state: "('norfolk','region','state','national')" };
const NEWS_HOSTS = /(wavy|13newsnow|pilotonline|whro|wtkr|covabizmag|virginiabusiness|news\.google|insidebiz|virginiamercury|richmond\.com)\./i;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const res = await route(req, env, ctx, url);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(e);
      return json({ error: 'Server error', detail: String(e.message || e).slice(0, 200) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env, { trigger: 'cron' }));
  },
};

// ---------- edit key (only for changing sources/models) ----------
async function pref(env, key) { return env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(key).first('value'); }
function sentKey(req) {
  const c = req.headers.get('cookie') || '';
  return decodeURIComponent(c.match(/(?:^|;\s*)eda_key=([^;]+)/)?.[1] || '') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
}
async function isEditor(req, env) {
  const key = sentKey(req);
  if (!key) return false;
  const stored = await pref(env, 'admin_key_hash');
  return !!stored && (await sha256(key)) === stored;
}

// Simple fixed-window rate limit in KV.
async function limited(env, bucket, max, windowSec) {
  const k = `rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = Number(await env.KV.get(k).catch(() => 0)) || 0;
  if (n >= max) return true;
  await env.KV.put(k, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) }).catch(() => {});
  return false;
}
const ip = req => req.headers.get('cf-connecting-ip') || 'anon';

async function route(req, env, ctx, url) {
  const p = url.pathname, m = req.method;
  let mm;

  // ----- open (read) -----
  if (p === '/api/me') return json({ editor: await isEditor(req, env) });
  if (p === '/api/dashboard' && m === 'GET') return json(await dashboard(env, geoOf(url)));
  if (p === '/api/trends' && m === 'GET') {
    const geo = geoOf(url);
    const key = `trends:${geo}`;
    let data = await env.KV.get(key, 'json').catch(() => null);
    if (!data) { data = { geo, metrics: await trends(env, geo) }; await env.KV.put(key, JSON.stringify(data), { expirationTtl: 3600 }).catch(() => {}); }
    return json(data);
  }
  if ((mm = p.match(/^\/api\/item\/(\d+)$/)) && m === 'GET') return json(await itemDetail(env, +mm[1]));
  if (p === '/api/sources' && m === 'GET') {
    const { results } = await env.DB.prepare(`SELECT s.id, s.name, s.url, s.tier, s.kind, s.cadence, s.tags, s.keyword_filter, s.origin, s.active, s.deleted_at, s.geo,
        s.last_fetched, s.last_new, s.last_error, s.fail_count, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count
        FROM sources s ORDER BY s.deleted_at IS NOT NULL, s.tier, s.name`).all();
    return json(results);
  }
  if (p === '/api/runs' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 20').all();
    return json(results);
  }
  if (p === '/api/ask' && m === 'POST') {
    if (await limited(env, `ask:${ip(req)}`, 20, 3600)) return json({ answer: "You've asked a lot this hour. Try again in a bit.", sources: [] }, 429);
    return json(await ask(env, await req.json().catch(() => ({}))));
  }
  if (p === '/api/run' && m === 'POST') {
    const running = await env.DB.prepare("SELECT id FROM runs WHERE finished_at IS NULL AND started_at >= datetime('now','-15 minutes') LIMIT 1").first();
    if (running) return json({ error: 'A scan is already running. Give it a minute.' }, 409);
    if (!(await isEditor(req, env)) && await limited(env, 'run', 1, 1200)) return json({ error: 'A scan ran in the last 20 minutes. Fresh results are already on the dashboard.' }, 429);
    return streamRun(env, ctx);
  }
  if (p === '/api/login' && m === 'POST') {
    if (await limited(env, `login:${ip(req)}`, 10, 900)) return json({ error: 'Too many tries. Wait 15 minutes.' }, 429);
    const { key } = await req.json().catch(() => ({}));
    const stored = await pref(env, 'admin_key_hash');
    if (!key || !stored || (await sha256(String(key))) !== stored) return json({ error: 'That edit key is not right.' }, 401);
    return json({ ok: true }, 200, { 'set-cookie': `eda_key=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` });
  }
  if (p === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': 'eda_key=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });

  // ----- edit (key) -----
  if (!(await isEditor(req, env))) return json({ error: 'edit-key', message: 'Enter the edit key to change sources or settings.' }, 401);
  if (m !== 'GET' && req.headers.get('origin') && new URL(req.headers.get('origin')).host !== url.host) return json({ error: 'Bad origin' }, 403);

  if ((mm = p.match(/^\/api\/signals\/(\d+)$/)) && m === 'POST') {
    const { status } = await req.json().catch(() => ({}));
    if (!['pinned', 'dismissed', 'seen', 'new'].includes(status)) return json({ error: 'Bad status' }, 400);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO signals (item_id, score, status) SELECT id, score, ? FROM items WHERE id = ? ON CONFLICT(item_id) DO UPDATE SET status = excluded.status').bind(status, +mm[1]),
      env.DB.prepare('INSERT INTO feedback (item_id, action) VALUES (?, ?)').bind(+mm[1], status),
    ]);
    await bust(env);
    return json({ ok: true });
  }
  if (p === '/api/sources/preview' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const u = safeUrl(b.url);
    if (!u) return json({ error: 'Use a public http(s) web address.' }, 400);
    if (!(await robotsAllows(env, u))) return json({ error: 'This site asks crawlers not to read that page (robots.txt). You can still add it as a linked reference.' }, 400);
    const r = await processSource(env, { id: 0, url: u, method: 'auto', kind: b.kind || 'news', tier: 1, name: 'Preview', keyword_filter: b.keyword_filter || null, link_pattern: null }, null, { dryRun: true });
    if (!r.ok) return json({ error: `Couldn't read that page: ${r.error}` }, 400);
    return json({ url: u, method: r.method, candidates: r.candidates.map(c => ({ title: c.title, url: c.url, published: c.published })) });
  }
  if (p === '/api/sources' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const u = safeUrl(b.url);
    if (!u) return json({ error: 'Use a public http(s) web address.' }, 400);
    const v = cleanSource(b);
    const row = await env.DB.prepare(`INSERT INTO sources (name, url, tier, method, cadence, tags, kind, keyword_filter, origin, active, geo) VALUES (?,?,?,?,?,?,?,?, 'added', 1, ?)
        ON CONFLICT(url) DO UPDATE SET deleted_at = NULL, active = 1 RETURNING *`)
      .bind(v.name || new URL(u).hostname, u, v.tier, v.method || 'auto', v.cadence, v.tags, v.kind, v.keyword_filter, v.geo).first();
    await audit(env, row.id, 'add', null, row);
    return json(row, 201);
  }
  if ((mm = p.match(/^\/api\/sources\/(\d+)(\/(test|restore))?$/))) {
    const id = +mm[1];
    const before = await env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first();
    if (!before) return json({ error: 'Not found' }, 404);
    if (mm[3] === 'test' && m === 'POST') {
      const r = await processSource(env, before, null, { dryRun: true });
      return json(r.ok ? { ok: true, method: r.method, candidates: r.candidates.map(c => ({ title: c.title, url: c.url, published: c.published })) } : { ok: false, error: r.error });
    }
    if (mm[3] === 'restore' && m === 'POST') {
      await env.DB.prepare('UPDATE sources SET deleted_at = NULL, active = 1 WHERE id = ?').bind(id).run();
      await audit(env, id, 'restore', before, null);
      return json({ ok: true });
    }
    if (m === 'PATCH') {
      const b = await req.json().catch(() => ({}));
      const v = cleanSource({ ...before, ...b });
      await env.DB.prepare('UPDATE sources SET name = ?, tier = ?, cadence = ?, tags = ?, kind = ?, keyword_filter = ?, geo = ?, active = ? WHERE id = ?')
        .bind(v.name, v.tier, v.cadence, v.tags, v.kind, v.keyword_filter, v.geo, b.active === undefined ? before.active : (b.active ? 1 : 0), id).run();
      await audit(env, id, 'edit', before, b);
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await env.DB.prepare("UPDATE sources SET deleted_at = datetime('now'), active = 0 WHERE id = ?").bind(id).run();
      await audit(env, id, 'remove', before, null);
      return json({ ok: true });
    }
  }
  if (p === '/api/models' && m === 'GET') {
    const { results: routes } = await env.DB.prepare('SELECT * FROM model_routes ORDER BY task').all();
    const { results: usage } = await env.DB.prepare(`SELECT task, provider, model, COUNT(*) calls, SUM(ok) ok, ROUND(AVG(latency_ms)) avg_ms, SUM(COALESCE(tokens_in,0)) tin, SUM(COALESCE(tokens_out,0)) tout
       FROM llm_calls WHERE at >= datetime('now','-30 days') GROUP BY task, provider, model ORDER BY task, calls DESC`).all();
    const keys = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OMNIROUTE_API_KEY'].filter(k => !!env[k]);
    return json({ routes: routes.map(r => ({ ...r, chain: JSON.parse(r.chain) })), usage, keysConnected: keys });
  }
  if ((mm = p.match(/^\/api\/models\/(\w+)$/)) && m === 'PUT') {
    const b = await req.json().catch(() => ({}));
    const chain = (Array.isArray(b.chain) ? b.chain : []).slice(0, 4).map(s => ({
      provider: s.provider === 'workers-ai' ? 'workers-ai' : 'openai-compat',
      model: String(s.model || '').slice(0, 120),
      ...(s.provider !== 'workers-ai' && s.base_url ? { base_url: safeUrl(s.base_url) } : {}),
      ...(s.key ? { key: String(s.key).replace(/[^A-Z_]/g, '').slice(0, 40) } : {}),
    })).filter(s => s.model);
    if (!chain.length) return json({ error: 'Add at least one model.' }, 400);
    await env.DB.prepare(`INSERT INTO model_routes (task, chain, max_tokens, daily_cap_calls) VALUES (?,?,?,?)
        ON CONFLICT(task) DO UPDATE SET chain = excluded.chain, max_tokens = excluded.max_tokens, daily_cap_calls = excluded.daily_cap_calls, updated_at = datetime('now')`)
      .bind(mm[1], JSON.stringify(chain), clamp(b.max_tokens, 50, 4000, 600), clamp(b.daily_cap_calls, 1, 500, 40)).run();
    clearRouteCache();
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}

const geoOf = url => GEOS.includes(url.searchParams.get('geo')) ? url.searchParams.get('geo') : 'norfolk';
const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d;
const bust = env => Promise.all(GEOS.flatMap(g => [env.KV.delete(`dashboard:v2:${g}`), env.KV.delete(`trends:${g}`)])).catch(() => {});

function cleanSource(b) {
  const pick = (v, ok, d) => ok.includes(v) ? v : d;
  return {
    name: String(b.name || '').trim().slice(0, 120),
    tier: clamp(b.tier, 1, 3, 1),
    method: pick(b.method, ['auto', 'html', 'rss', 'pdf'], 'auto'),
    cadence: pick(b.cadence, ['daily', 'weekly', 'monthly'], 'daily'),
    kind: pick(b.kind, ['news', 'meetings', 'cityhall', 'properties', 'grants', 'context', 'reference'], 'news'),
    geo: pick(b.geo, ['norfolk', 'region', 'state', 'national'], 'norfolk'),
    tags: String(b.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 6).join(',').slice(0, 200),
    keyword_filter: String(b.keyword_filter || '').trim().slice(0, 300) || null,
  };
}

async function audit(env, id, action, before, after) {
  await env.DB.prepare('INSERT INTO source_changes (source_id, action, before, after) VALUES (?,?,?,?)')
    .bind(id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run().catch(() => {});
}

function streamRun(env, ctx) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = o => w.write(enc.encode(JSON.stringify(o) + '\n')).catch(() => {});
  ctx.waitUntil(runDaily(env, { trigger: 'manual', force: true, onProgress: send })
    .catch(e => send({ type: 'error', error: String(e.message || e) }))
    .finally(() => { bust(env); w.close().catch(() => {}); }));
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

// ---------- dashboard (cached 5 min per geography) ----------
async function dashboard(env, geo) {
  const ck = `dashboard:v2:${geo}`;
  const cached = await env.KV.get(ck, 'json').catch(() => null);
  if (cached) return cached;
  const db = env.DB, G = GEO_SQL[geo];
  const ITEM = `i.id, i.title, i.url, i.summary, i.why, i.score, i.type, i.tags, i.rule_hits, i.published_at, i.found_at, s.name AS source, s.geo`;
  const [brief, signals, meetings, cityhall, latest, lastRun, counts, health, weekly, money, moneyTotals, awards, momentum, library, outlookRow] = await Promise.all([
    db.prepare("SELECT * FROM briefs WHERE kind = 'daily' ORDER BY period DESC LIMIT 1").first(),
    db.prepare(`SELECT ${ITEM}, g.status, g.rule_hit FROM signals g JOIN items i ON i.id = g.item_id JOIN sources s ON s.id = i.source_id
       WHERE g.status != 'dismissed' AND i.type NOT IN ('meeting','context') AND s.geo IN ${G} AND (i.published_at IS NULL OR i.published_at >= date('now','-180 days') OR g.status = 'pinned')
       ORDER BY (g.status = 'pinned') DESC, i.found_at >= datetime('now','-2 days') DESC, i.score DESC LIMIT 30`).all(),
    db.prepare(`SELECT m.body, m.doc_kind, m.meeting_date, m.doc_url, m.actions, m.created_at, i.id, i.summary, i.why, i.title FROM meetings m LEFT JOIN items i ON i.id = m.item_id
       ORDER BY m.meeting_date DESC, m.id DESC LIMIT 8`).all(),
    db.prepare(`SELECT ${ITEM} FROM items i JOIN sources s ON s.id = i.source_id WHERE s.kind = 'cityhall' ORDER BY i.found_at DESC, i.id DESC LIMIT 12`).all(),
    db.prepare(`SELECT ${ITEM} FROM items i JOIN sources s ON s.id = i.source_id WHERE i.type NOT IN ('context') AND s.geo IN ${G} ORDER BY i.found_at DESC, i.score DESC LIMIT 40`).all(),
    db.prepare("SELECT *, CASE WHEN finished_at IS NULL AND started_at < datetime('now','-15 minutes') THEN 1 ELSE 0 END AS stale FROM runs ORDER BY id DESC LIMIT 1").first(),
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM signals g WHERE g.created_at >= datetime('now','-30 hours') AND g.status != 'dismissed') AS new_signals,
        (SELECT COUNT(*) FROM sources WHERE active = 1 AND deleted_at IS NULL) AS active_sources,
        (SELECT COUNT(*) FROM items) AS total_items`).first(),
    db.prepare(`SELECT SUM(CASE WHEN fail_count = 0 AND last_ok IS NOT NULL THEN 1 ELSE 0 END) ok, SUM(CASE WHEN fail_count > 0 THEN 1 ELSE 0 END) failing,
        SUM(CASE WHEN last_fetched IS NULL THEN 1 ELSE 0 END) pending FROM sources WHERE active = 1 AND deleted_at IS NULL`).first(),
    db.prepare("SELECT * FROM briefs WHERE kind = 'weekly' ORDER BY period DESC LIMIT 1").first(),
    db.prepare(`SELECT mo.amount, mo.label, mo.kind, mo.found_at, i.id, i.title, i.url, s.name AS source FROM money mo JOIN items i ON i.id = mo.item_id JOIN sources s ON s.id = i.source_id
       WHERE s.geo IN ${G} AND (i.published_at IS NULL OR i.published_at >= date('now','-365 days')) ORDER BY mo.found_at >= datetime('now','-45 days') DESC, mo.amount DESC LIMIT 14`).all(),
    db.prepare(`SELECT mo.kind, COUNT(*) n, SUM(mo.amount) total FROM money mo JOIN items i ON i.id = mo.item_id JOIN sources s ON s.id = i.source_id
       WHERE mo.found_at >= datetime('now','-90 days') AND s.geo IN ${G} AND (i.published_at IS NULL OR i.published_at >= date('now','-365 days')) GROUP BY mo.kind ORDER BY total DESC`).all(),
    db.prepare('SELECT * FROM awards ORDER BY start_date DESC, amount DESC LIMIT 10').all(),
    db.prepare(`SELECT i.tags, strftime('%Y-%W', i.found_at) wk, COUNT(*) n FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.found_at >= datetime('now','-56 days') AND i.type != 'context' AND s.geo IN ${G} GROUP BY i.tags, wk`).all(),
    db.prepare(`SELECT ${ITEM}, s.kind FROM items i JOIN sources s ON s.id = i.source_id WHERE i.type = 'context' ORDER BY s.tier, s.name LIMIT 24`).all(),
    db.prepare("SELECT body, created_at, model FROM briefs WHERE kind = 'eda_outlook' ORDER BY id DESC LIMIT 1").first(),
  ]);
  const outlook = outlookRow ? { ...JSON.parse(outlookRow.body), created: outlookRow.created_at } : null;

  const parsed = brief ? JSON.parse(brief.body) : null;
  const wk = weekly ? JSON.parse(weekly.body) : null;
  const ids = [...new Set([...[...(parsed?.bullets || []), ...(wk?.bullets || [])].flatMap(b => b.items), ...[...(outlook?.last_meeting?.decisions || []), ...(outlook?.initiatives || []), ...(outlook?.upcoming || [])].flatMap(x => x.ids || [])])].slice(0, 80);
  let cites = {};
  if (ids.length) {
    const { results } = await db.prepare(`SELECT ${ITEM} FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    cites = Object.fromEntries(results.map(r => [r.id, r]));
  }

  // Topic momentum: items per tag per week (last 8 weeks).
  const tagWeeks = {};
  for (const r of momentum.results) for (const t of String(r.tags || '').split(',').filter(Boolean)) {
    tagWeeks[t] ??= {}; tagWeeks[t][r.wk] = (tagWeeks[t][r.wk] || 0) + r.n;
  }
  const weeks = [...new Set(momentum.results.map(r => r.wk))].sort().slice(-8);
  const topics = Object.entries(tagWeeks).map(([tag, w]) => ({ tag, total: Object.values(w).reduce((a, b) => a + b, 0), weeks: weeks.map(k => w[k] || 0) }))
    .sort((a, b) => b.total - a.total).slice(0, 8);

  const out = {
    geo, asOf: new Date().toISOString(),
    brief: parsed ? { period: brief.period, created: brief.created_at, model: brief.model, ...parsed } : null,
    weekly: wk ? { period: weekly.period, ...wk } : null,
    cites,
    signals: signals.results,
    meetings: meetings.results.map(r => ({ ...r, actions: safeParse(r.actions) })),
    cityhall: cityhall.results,
    latest: latest.results,
    lastRun, kpis: { ...counts, nextEda: nextFirstWednesday() }, health,
    money: { items: money.results, totals: moneyTotals.results },
    awards: awards.results,
    topics: { weeks, list: topics },
    library: library.results,
    outlook,
  };
  await env.KV.put(ck, JSON.stringify(out), { expirationTtl: 300 }).catch(() => {});
  return out;
}

const safeParse = s => { try { return JSON.parse(s); } catch { return null; } };

function nextFirstWednesday() {
  const now = new Date(Date.now() - 4 * 3600e3);
  for (let add = 0; add < 3; add++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + add, 1));
    while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
    if (d.toISOString().slice(0, 10) >= now.toISOString().slice(0, 10)) return d.toISOString().slice(0, 10);
  }
  return null;
}

// ---------- story detail (for the modal) ----------
async function itemDetail(env, id) {
  const it = await env.DB.prepare(`SELECT i.*, s.name AS source, s.url AS source_url, s.geo, s.kind AS source_kind FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).bind(id).first();
  if (!it) return { error: 'Not found' };
  const [money, related, meeting] = await Promise.all([
    env.DB.prepare('SELECT amount, label, kind FROM money WHERE item_id = ? ORDER BY amount DESC').bind(id).all(),
    env.DB.prepare(`SELECT i.id, i.title, i.url, i.found_at, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.id != ? AND i.type != 'context' AND (${String(it.tags || 'none').split(',').filter(Boolean).slice(0, 2).map(() => "(',' || i.tags || ',') LIKE ?").join(' OR ') || '0'})
       ORDER BY i.found_at DESC LIMIT 5`).bind(id, ...String(it.tags || '').split(',').filter(Boolean).slice(0, 2).map(t => `%,${t},%`)).all(),
    env.DB.prepare('SELECT body, doc_kind, meeting_date, actions FROM meetings WHERE item_id = ?').bind(id).first(),
  ]);
  // News articles: short excerpt only (copyright); public documents: a longer excerpt.
  const isNews = NEWS_HOSTS.test(it.url);
  const excerpt = String(it.raw_excerpt || '').replace(/\s+\n/g, '\n').trim();
  return {
    id: it.id, title: it.title, url: it.url, source: it.source, sourceUrl: it.source_url, geo: it.geo,
    published: it.published_at, found: it.found_at, tags: it.tags, score: it.score, type: it.type,
    summary: it.summary, why: it.why,
    excerpt: excerpt ? (isNews ? excerpt.slice(0, 420) + (excerpt.length > 420 ? '…' : '') : excerpt.slice(0, 2600) + (excerpt.length > 2600 ? '…' : '')) : '',
    excerptKind: isNews ? 'news' : 'document',
    money: money.results, related: related.results,
    meeting: meeting ? { ...meeting, actions: safeParse(meeting.actions) } : null,
  };
}

// ---------- Ask ----------
async function ask(env, { q }) {
  const question = String(q || '').trim().slice(0, 300);
  if (!question) return { answer: 'Ask me about Norfolk economic development.', sources: [] };
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9$]{3,}/g) || [])]
    .filter(w => !['what', 'when', 'where', 'which', 'with', 'about', 'there', 'that', 'this', 'have', 'does', 'from', 'norfolk', 'any', 'the', 'and', 'for', 'are', 'was', 'were', 'did', 'last', 'new', 'tell', 'how', 'many', 'much'].includes(w)).slice(0, 6);
  let rows = [];
  if (words.length) {
    const where = words.map(() => "(LOWER(i.title) LIKE ? OR LOWER(COALESCE(i.summary, i.raw_excerpt, '')) LIKE ?)").join(' OR ');
    ({ results: rows } = await env.DB.prepare(`SELECT i.id, i.title, i.url, COALESCE(i.summary, SUBSTR(i.raw_excerpt, 1, 400)) AS text, i.found_at, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
       WHERE ${where} ORDER BY i.found_at DESC, i.score DESC LIMIT 8`).bind(...words.flatMap(w => [`%${w}%`, `%${w}%`])).all());
  }
  if (/eda|meeting|approv|minutes|agenda/i.test(question)) {
    const { results } = await env.DB.prepare(`SELECT i.id, i.title, i.url, COALESCE(i.summary, '') AS text, i.found_at, 'Norfolk EDA' AS source FROM meetings m JOIN items i ON i.id = m.item_id ORDER BY m.meeting_date DESC LIMIT 3`).all();
    rows = [...results, ...rows.filter(r => !results.some(x => x.id === r.id))].slice(0, 8);
  }
  // Trend questions: add the latest numbers.
  let facts = '';
  const want = new Set(Object.entries({
    unemp: /unemploy|jobless|labor/i, jobs: /\bjobs?\b|employ|hiring|workforce/i, list_price: /home|house|housing|price|afford/i,
    listings: /listing|inventory|for sale|supply/i, dom: /days on market|selling|market/i, permits: /permit|construction|new homes|build/i,
    hpi: /home value|house price|appreciat/i, income: /income|wage|earn|pay/i, gdp: /gdp|economy|output|growth/i,
  }).filter(([, re]) => re.test(question)).map(([k]) => k));
  if (want.size) {
    const geos = /virginia|state/i.test(question) ? ['state'] : /hampton roads|region|metro/i.test(question) ? ['region'] : ['norfolk', 'region', 'state'];
    for (const geo of geos) {
      const t = (await trends(env, geo)).filter(x => want.has(x.key));
      facts += t.map(x => `${geoName(geo)} ${x.label}: ${fmtVal(x.latest.v, x.unit)} (${x.latest.d})${x.change != null ? x.unit === '%' ? `, ${x.change >= 0 ? 'up' : 'down'} ${Math.abs(x.change).toFixed(1)} points from a year earlier` : `, ${x.pct >= 0 ? 'up' : 'down'} ${Math.abs(x.pct).toFixed(1)}% from a year earlier` : ''}`).join('\n') + (t.length ? '\n' : '');
    }
  }
  if (!rows.length && !facts) return { answer: "I don't have that in the sources I track yet.", sources: [] };
  const out = await chat(env, 'voice', [
    { role: 'system', content: 'You answer questions about Norfolk, Virginia economic development for a civic audience, in at most 3 short sentences suitable for reading aloud. Use only the items and figures given. If they do not answer the question, say so. Do not invent numbers or names.' },
    { role: 'user', content: `Question: ${question}\n\n${facts ? `Figures (FRED):\n${facts}\n` : ''}Items:\n${rows.map(r => `[${r.id}] ${r.source}: ${r.title}. ${r.text}`).join('\n')}` },
  ], {});
  return {
    answer: out?.text?.trim() || (rows.length ? `Here's what I found: ${rows.slice(0, 3).map(r => r.title).join('; ')}.` : facts.split('\n')[0]),
    sources: [...rows.slice(0, 5).map(r => ({ id: r.id, title: r.title, url: r.url, source: r.source })), ...(facts ? [{ title: 'Federal Reserve Economic Data', url: 'https://fred.stlouisfed.org/', source: 'FRED' }] : [])],
  };
}
const geoName = g => ({ norfolk: 'Norfolk', region: 'Hampton Roads', state: 'Virginia' }[g]);
const fmtVal = (v, u) => u === '$' ? `$${Math.round(v).toLocaleString('en-US')}` : u === '%' ? `${v.toFixed(1)}%` : u === 'k' ? `${v.toFixed(1)}k` : Math.round(v).toLocaleString('en-US');
export { METRICS };
