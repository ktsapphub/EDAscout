// EDAScout Worker: serves the dashboard (static ./public) and the JSON API, and runs the daily scan on cron.
import { json, safeUrl, sha256, robotsAllows, today } from './util.js';
import { runDaily, processSource } from './pipeline.js';
import { chat, clearRouteCache } from './llm.js';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

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

// ---------- auth: one owner key, stored as a hash in D1 prefs; sent as an HttpOnly cookie ----------
async function pref(env, key) {
  return env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(key).first('value');
}
function cookieKey(req) {
  const c = req.headers.get('cookie') || '';
  return decodeURIComponent(c.match(/(?:^|;\s*)eda_key=([^;]+)/)?.[1] || '') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
}
async function isOwner(req, env) {
  const key = cookieKey(req);
  if (!key) return false;
  const stored = await pref(env, 'admin_key_hash');
  return !!stored && (await sha256(key)) === stored;
}
async function canView(req, env) {
  return (await pref(env, 'public_view')) === '1' || isOwner(req, env);
}
const deny = () => json({ error: 'Sign in required' }, 401);

// ---------- router ----------
async function route(req, env, ctx, url) {
  const p = url.pathname, m = req.method;
  const owner = await isOwner(req, env);

  if (p === '/api/login' && m === 'POST') {
    const { key } = await req.json().catch(() => ({}));
    const stored = await pref(env, 'admin_key_hash');
    if (!key || !stored || (await sha256(String(key))) !== stored) return json({ error: 'Wrong key' }, 401);
    return json({ ok: true }, 200, { 'set-cookie': `eda_key=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` });
  }
  if (p === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': 'eda_key=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  if (p === '/api/me') return json({ owner, publicView: (await pref(env, 'public_view')) === '1' });

  if (!(owner || (await canView(req, env)))) return deny();

  if (p === '/api/dashboard' && m === 'GET') return json(await dashboard(env));
  if (p === '/api/ask' && m === 'POST') return json(await ask(env, await req.json().catch(() => ({}))));

  // Everything below changes data: owner only.
  if (!owner) return deny();
  if (m !== 'GET' && req.headers.get('origin') && new URL(req.headers.get('origin')).host !== url.host) return json({ error: 'Bad origin' }, 403);

  if (p === '/api/run' && m === 'POST') return streamRun(env, ctx);
  if (p === '/api/runs' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 20').all();
    return json(results);
  }
  if (p === '/api/settings' && m === 'PATCH') {
    const b = await req.json().catch(() => ({}));
    if ('publicView' in b) await env.DB.prepare("INSERT INTO prefs (key, value) VALUES ('public_view', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(b.publicView ? '1' : '0').run();
    await env.KV.delete('dashboard:v1').catch(() => {});
    return json({ ok: true });
  }

  let mm;
  if ((mm = p.match(/^\/api\/signals\/(\d+)$/)) && m === 'POST') {
    const { status } = await req.json().catch(() => ({}));
    if (!['pinned', 'dismissed', 'seen', 'new'].includes(status)) return json({ error: 'Bad status' }, 400);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO signals (item_id, score, status) SELECT id, score, ? FROM items WHERE id = ? ON CONFLICT(item_id) DO UPDATE SET status = excluded.status').bind(status, +mm[1], ),
      env.DB.prepare('INSERT INTO feedback (item_id, action) VALUES (?, ?)').bind(+mm[1], status),
    ]);
    await env.KV.delete('dashboard:v1').catch(() => {});
    return json({ ok: true });
  }

  // ----- Source Manager -----
  if (p === '/api/sources' && m === 'GET') {
    const { results } = await env.DB.prepare(`SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count FROM sources s ORDER BY s.deleted_at IS NOT NULL, s.tier, s.name`).all();
    return json(results);
  }
  if (p === '/api/sources/preview' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const u = safeUrl(b.url);
    if (!u) return json({ error: 'Use a public http(s) web address.' }, 400);
    if (!(await robotsAllows(env, u))) return json({ error: 'This site asks crawlers not to read that page (robots.txt).' }, 400);
    const r = await processSource(env, { id: 0, url: u, method: 'auto', kind: b.kind || 'news', tier: 1, name: 'Preview', keyword_filter: b.keyword_filter || null, link_pattern: null }, null, { dryRun: true });
    if (!r.ok) return json({ error: `Couldn't read that page: ${r.error}` }, 400);
    return json({ url: u, method: r.method, candidates: r.candidates.map(c => ({ title: c.title, url: c.url, published: c.published })) });
  }
  if (p === '/api/sources' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const u = safeUrl(b.url);
    if (!u) return json({ error: 'Use a public http(s) web address.' }, 400);
    const v = cleanSource(b);
    const row = await env.DB.prepare(`INSERT INTO sources (name, url, tier, method, cadence, tags, kind, keyword_filter, origin, active) VALUES (?,?,?,?,?,?,?,?, 'added', 1)
        ON CONFLICT(url) DO UPDATE SET deleted_at = NULL, active = 1 RETURNING *`)
      .bind(v.name || new URL(u).hostname, u, v.tier, v.method || 'auto', v.cadence, v.tags, v.kind, v.keyword_filter).first();
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
      await env.DB.prepare('UPDATE sources SET name = ?, tier = ?, cadence = ?, tags = ?, kind = ?, keyword_filter = ?, active = ? WHERE id = ?')
        .bind(v.name, v.tier, v.cadence, v.tags, v.kind, v.keyword_filter, b.active === undefined ? before.active : (b.active ? 1 : 0), id).run();
      await audit(env, id, 'edit', before, b);
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await env.DB.prepare("UPDATE sources SET deleted_at = datetime('now'), active = 0 WHERE id = ?").bind(id).run();
      await audit(env, id, 'remove', before, null);
      return json({ ok: true });
    }
  }

  // ----- Models (vendor-neutral routing) -----
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

const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d;

function cleanSource(b) {
  const pick = (v, ok, d) => ok.includes(v) ? v : d;
  return {
    name: String(b.name || '').trim().slice(0, 120),
    tier: clamp(b.tier, 1, 3, 1),
    method: pick(b.method, ['auto', 'html', 'rss', 'pdf'], 'auto'),
    cadence: pick(b.cadence, ['daily', 'weekly', 'monthly'], 'daily'),
    kind: pick(b.kind, ['news', 'meetings', 'cityhall', 'properties', 'grants', 'context'], 'news'),
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
    .finally(() => w.close().catch(() => {})));
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

// ---------- dashboard payload (cached 5 minutes in KV; cleared after each run or change) ----------
async function dashboard(env) {
  const cached = await env.KV.get('dashboard:v1', 'json').catch(() => null);
  if (cached) return cached;
  const db = env.DB;
  const ITEM = `i.id, i.title, i.url, i.summary, i.why, i.score, i.type, i.tags, i.rule_hits, i.published_at, i.found_at, s.name AS source, s.url AS source_url`;
  const [brief, signals, meetings, cityhall, latest, lastRun, counts, health, weekly] = await Promise.all([
    db.prepare("SELECT * FROM briefs WHERE kind = 'daily' ORDER BY period DESC LIMIT 1").first(),
    db.prepare(`SELECT ${ITEM}, g.status, g.rule_hit FROM signals g JOIN items i ON i.id = g.item_id JOIN sources s ON s.id = i.source_id
       WHERE g.status != 'dismissed' AND i.type != 'meeting' ORDER BY (g.status = 'pinned') DESC, i.found_at >= datetime('now','-2 days') DESC, i.score DESC LIMIT 30`).all(),
    db.prepare(`SELECT m.body, m.doc_kind, m.meeting_date, m.doc_url, m.actions, i.id, i.summary, i.why, i.title FROM meetings m LEFT JOIN items i ON i.id = m.item_id
       ORDER BY m.meeting_date DESC, m.id DESC LIMIT 8`).all(),
    db.prepare(`SELECT ${ITEM} FROM items i JOIN sources s ON s.id = i.source_id WHERE s.kind = 'cityhall' ORDER BY i.found_at DESC, i.id DESC LIMIT 12`).all(),
    db.prepare(`SELECT ${ITEM} FROM items i JOIN sources s ON s.id = i.source_id WHERE i.type != 'context' ORDER BY i.found_at DESC, i.score DESC LIMIT 40`).all(),
    db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').first(),
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM signals g JOIN items i ON i.id = g.item_id WHERE g.created_at >= datetime('now','-30 hours') AND g.status != 'dismissed') AS new_signals,
        (SELECT COUNT(*) FROM sources WHERE active = 1 AND deleted_at IS NULL) AS active_sources,
        (SELECT COUNT(*) FROM items) AS total_items,
        (SELECT COUNT(*) FROM items WHERE type = 'grant' AND found_at >= datetime('now','-14 days')) AS grant_items`).first(),
    db.prepare(`SELECT SUM(CASE WHEN fail_count = 0 AND last_ok IS NOT NULL THEN 1 ELSE 0 END) ok, SUM(CASE WHEN fail_count > 0 THEN 1 ELSE 0 END) failing,
        SUM(CASE WHEN last_fetched IS NULL THEN 1 ELSE 0 END) pending FROM sources WHERE active = 1 AND deleted_at IS NULL`).first(),
    db.prepare("SELECT * FROM briefs WHERE kind = 'weekly' ORDER BY period DESC LIMIT 1").first(),
  ]);

  // Resolve brief citations to their sources.
  const citeIds = new Set();
  const parsed = brief ? JSON.parse(brief.body) : null;
  parsed?.bullets?.forEach(b => b.items.forEach(i => citeIds.add(i)));
  const wk = weekly ? JSON.parse(weekly.body) : null;
  wk?.bullets?.forEach(b => b.items.forEach(i => citeIds.add(i)));
  let cites = {};
  if (citeIds.size) {
    const ids = [...citeIds].slice(0, 60);
    const { results } = await db.prepare(`SELECT i.id, i.title, i.url, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    cites = Object.fromEntries(results.map(r => [r.id, r]));
  }

  const out = {
    asOf: new Date().toISOString(),
    brief: parsed ? { period: brief.period, created: brief.created_at, model: brief.model, ...parsed } : null,
    weekly: wk ? { period: weekly.period, ...wk } : null,
    cites,
    signals: signals.results,
    meetings: meetings.results.map(m => ({ ...m, actions: safeParse(m.actions) })),
    cityhall: cityhall.results,
    latest: latest.results,
    lastRun,
    kpis: { ...counts, nextEda: nextFirstWednesday() },
    health,
  };
  await env.KV.put('dashboard:v1', JSON.stringify(out), { expirationTtl: 300 }).catch(() => {});
  return out;
}

const safeParse = s => { try { return JSON.parse(s); } catch { return null; } };

function nextFirstWednesday() {
  // EDA meets the first Wednesday of the month at noon (per norfolkdevelopment.com). Computed; confirm on the EDA page.
  const now = new Date(Date.now() - 4 * 3600e3);
  for (let add = 0; add < 3; add++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + add, 1));
    while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
    if (d.toISOString().slice(0, 10) >= now.toISOString().slice(0, 10)) return d.toISOString().slice(0, 10);
  }
  return null;
}

// ---------- Ask (text or voice): keyword retrieval over stored items + the cheapest "voice" model ----------
async function ask(env, { q }) {
  const question = String(q || '').trim().slice(0, 300);
  if (!question) return { answer: 'Ask me about Norfolk economic development.', sources: [] };
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9$]{3,}/g) || [])]
    .filter(w => !['what', 'when', 'where', 'which', 'with', 'about', 'there', 'that', 'this', 'have', 'does', 'from', 'norfolk', 'any', 'the', 'and', 'for', 'are', 'was', 'were', 'did', 'last', 'new', 'tell'].includes(w)).slice(0, 6);
  let rows = [];
  if (words.length) {
    const where = words.map(() => '(LOWER(i.title) LIKE ? OR LOWER(COALESCE(i.summary, i.raw_excerpt, \'\')) LIKE ?)').join(' OR ');
    const args = words.flatMap(w => [`%${w}%`, `%${w}%`]);
    ({ results: rows } = await env.DB.prepare(`SELECT i.id, i.title, i.url, COALESCE(i.summary, SUBSTR(i.raw_excerpt, 1, 400)) AS text, i.found_at, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
       WHERE ${where} ORDER BY i.found_at DESC, i.score DESC LIMIT 8`).bind(...args).all());
  }
  if (/eda|meeting|approv|minutes|agenda/i.test(question)) {
    const { results } = await env.DB.prepare(`SELECT i.id, i.title, i.url, COALESCE(i.summary, '') AS text, i.found_at, 'Norfolk EDA' AS source FROM meetings m JOIN items i ON i.id = m.item_id ORDER BY m.meeting_date DESC LIMIT 3`).all();
    rows = [...results, ...rows.filter(r => !results.some(x => x.id === r.id))].slice(0, 8);
  }
  if (!rows.length) return { answer: "I don't have that in the sources I track yet. Try adding a source for it in Admin.", sources: [] };
  const out = await chat(env, 'voice', [
    { role: 'system', content: 'You answer questions about Norfolk, Virginia economic development for a civic leader, in at most 3 short sentences suitable for reading aloud. Use only the items given. If they do not answer the question, say so. Do not invent numbers or names.' },
    { role: 'user', content: `Question: ${question}\n\nItems:\n${rows.map(r => `[${r.id}] ${r.source}: ${r.title}. ${r.text}`).join('\n')}` },
  ], {});
  return {
    answer: out?.text?.trim() || `Here's what I found: ${rows.slice(0, 3).map(r => r.title).join('; ')}.`,
    sources: rows.slice(0, 5).map(r => ({ id: r.id, title: r.title, url: r.url, source: r.source })),
  };
}
