// Daily pipeline: fetch → diff → extract → score (rules) → summarize (cheap model, batched) → signals → brief.
import { politeFetch, robotsAllows, sha256, extractLinks, contentLinks, parseFeed, mainText, pageTitle, pageDate,
  stripTags, dateFromText, lastDateIn, safeUrl, isoDate, today } from './util.js';
import { scoreItem, watchRule } from './score.js';
import { chat, budget as newBudget } from './llm.js';

const CADENCE_DAYS = { daily: 0.8, weekly: 6.5, monthly: 27 };

export async function dueSources(env, force = false) {
  const { results } = await env.DB.prepare('SELECT * FROM sources WHERE active = 1 AND deleted_at IS NULL ORDER BY tier, id').all();
  if (force) return results;
  return results.filter(s => !s.last_fetched || (Date.now() - Date.parse(s.last_fetched + 'Z')) / 864e5 >= (CADENCE_DAYS[s.cadence] ?? 0.8));
}

/** Full run. onProgress(event) receives small progress objects (used to stream "Run now" to the admin page). */
export async function runDaily(env, { trigger = 'cron', force = false, onProgress = () => {} } = {}) {
  const run = await env.DB.prepare('INSERT INTO runs (kind, trigger) VALUES (?, ?) RETURNING id, started_at').bind('daily', trigger).first();
  const ctx = { runId: run.id, startedAt: run.started_at, budget: newBudget(env), newItems: 0, ok: 0, failed: 0 };
  const sources = await dueSources(env, force);
  onProgress({ type: 'start', run: run.id, sources: sources.length });

  let i = 0;
  const worker = async () => {
    while (i < sources.length) {
      const src = sources[i++];
      const r = await processSource(env, src, ctx);
      r.ok ? ctx.ok++ : ctx.failed++;
      ctx.newItems += r.newItems || 0;
      onProgress({ type: 'source', id: src.id, name: src.name, ok: r.ok, newItems: r.newItems || 0, error: r.error || null });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  onProgress({ type: 'phase', phase: 'summarizing' });
  await summarizeNew(env, ctx);
  onProgress({ type: 'phase', phase: 'brief' });
  const brief = await writeDailyBrief(env, ctx);
  if (new Date().getUTCDay() === 1) await writeWeekly(env, ctx).catch(() => {});

  await env.DB.prepare(`UPDATE runs SET finished_at = datetime('now'), ok = ?, sources_ok = ?, sources_failed = ?, items_new = ?, llm_calls = ? WHERE id = ?`)
    .bind(ctx.failed > ctx.ok ? 0 : 1, ctx.ok, ctx.failed, ctx.newItems, ctx.budget.used, run.id).run();
  await env.KV.delete('dashboard:v1').catch(() => {});
  const summary = { type: 'done', run: run.id, sourcesOk: ctx.ok, sourcesFailed: ctx.failed, newItems: ctx.newItems, llmCalls: ctx.budget.used, brief: !!brief };
  onProgress(summary);
  return summary;
}

/** Fetch one source and store what's new. With { dryRun } nothing is written and candidates are returned (preview / test now). */
export async function processSource(env, src, ctx, { dryRun = false } = {}) {
  const maxItems = Number(env.MAX_ITEMS_PER_SOURCE || 8);
  try {
    const url = safeUrl(src.url);
    if (!url) throw new Error('URL not allowed');
    if (!(await robotsAllows(env, url))) throw new Error('Blocked by robots.txt');
    const firstRun = !src.last_hash;
    const r = await politeFetch(url, dryRun ? {} : { etag: src.etag, lastModified: src.last_modified });
    if (r.status === 304) { if (!dryRun) await markOk(env, src, {}); return { ok: true, newItems: 0 }; }
    const hash = await sha256(r.isBinary ? r.body : r.body);
    if (!dryRun && hash === src.last_hash) { await markOk(env, src, { etag: r.etag, lastModified: r.lastModified }); return { ok: true, newItems: 0 }; }

    const method = src.method === 'auto' ? detectMethod(r) : src.method;
    let cands = buildCandidates(src, r, method, url);
    cands = cands.map(c => ({ ...c, url: safeUrl(c.url) })).filter(c => c.url);
    if (src.keyword_filter) {
      const kws = src.keyword_filter.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
      cands = cands.filter(c => kws.some(k => `${c.title} ${c.excerpt || ''}`.toLowerCase().includes(k)));
    }

    if (dryRun) return { ok: true, method, candidates: cands.slice(0, 5) };

    // Diff against links already seen for this source.
    const { results: seenRows } = await env.DB.prepare('SELECT url FROM seen_links WHERE source_id = ?').bind(src.id).all();
    const seen = new Set(seenRows.map(x => x.url));
    const fresh = cands.filter(c => !seen.has(c.url));
    if (fresh.length) {
      const ins = env.DB.prepare('INSERT OR IGNORE INTO seen_links (source_id, url) VALUES (?, ?)');
      for (let k = 0; k < fresh.length; k += 50) await env.DB.batch(fresh.slice(k, k + 50).map(c => ins.bind(src.id, c.url)));
    }

    let keep = fresh;
    if (src.kind === 'meetings') {
      keep = fresh.filter(c => /\.pdf($|\?)/i.test(c.url))
        .sort((a, b) => (dateFromText(b.url) || '').localeCompare(dateFromText(a.url) || ''))
        .slice(0, firstRun ? 4 : 6);
    } else {
      keep = fresh.slice(0, firstRun ? Math.min(5, maxItems) : maxItems);
    }

    let added = 0, pageFetches = 0;
    for (const c of keep) {
      if (src.kind === 'meetings' && /\.pdf($|\?)/i.test(c.url)) { if (await handleMeetingDoc(env, src, c, ctx)) added++; continue; }
      // Enrich same-site HTML links with the article's own title/date/text (max 3 extra fetches per source).
      if (!c.excerpt && c.enrich && pageFetches < 3 && src.kind !== 'cityhall') {
        pageFetches++;
        try {
          if (await robotsAllows(env, c.url)) {
            const p = await politeFetch(c.url, { maxBytes: 3_000_000 });
            if (p.isBinary) c.excerpt = (await pdfToText(env, p.body)).slice(0, 2000);
            else { c.title = pageTitle(p.body) || c.title; c.published = c.published || pageDate(p.body); c.excerpt = mainText(p.body, 2000); }
          }
        } catch { /* keep link context */ }
      }
      if (await insertItem(env, src, c, ctx)) added++;
    }

    await markOk(env, src, { etag: r.etag, lastModified: r.lastModified, hash, newItems: added });
    return { ok: true, newItems: added };
  } catch (e) {
    const error = String(e.message || e).slice(0, 300);
    if (!dryRun) await env.DB.prepare(`UPDATE sources SET last_fetched = datetime('now'), last_error = ?, fail_count = fail_count + 1 WHERE id = ?`).bind(error, src.id).run();
    return { ok: false, newItems: 0, error };
  }
}

function detectMethod(r) {
  if (r.isBinary) return 'pdf';
  if (/xml|rss|atom/i.test(r.type) || /^\s*<\?xml|<rss|<feed/i.test(r.body.slice(0, 500))) return 'rss';
  return 'html';
}

function buildCandidates(src, r, method, url) {
  if (method === 'rss') {
    return parseFeed(r.body).map(i => ({ url: i.url, title: i.title, published: i.published, excerpt: i.excerpt }));
  }
  if (method === 'pdf' || r.isBinary) {
    return [{ url, title: src.name, pdfBody: r.body, published: null }];
  }
  if (src.kind === 'context') {
    return [{ url: r.finalUrl || url, title: pageTitle(r.body) || src.name, published: pageDate(r.body), excerpt: mainText(r.body, 2500) }];
  }
  const links = contentLinks(extractLinks(r.body, r.finalUrl || url), r.finalUrl || url, { pattern: src.link_pattern });
  return links.map(l => {
    let title = l.text;
    const isPdf = /\.pdf($|\?)/i.test(l.url);
    if (isPdf && title.length < 25) {
      title = decodeURIComponent(l.url.split('/').pop().replace(/\.pdf.*$/i, '')).replace(/[-_]+/g, ' ').trim() || title;
    }
    if (title.length < 25 && l.after) title = `${l.after.replace(/\b(Agenda Packet|Agenda|Minutes|Summary|Video)\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 90)}${title ? ' — ' + title : ''}`;
    return { url: l.url, title: title.slice(0, 200), context: `${l.before} ${l.after}`, nearDate: lastDateIn(l.before), published: dateFromText(l.text) ? isoDate(dateFromText(l.text)) : null, enrich: !isPdf };
  });
}

async function insertItem(env, src, c, ctx, extra = {}) {
  const text = `${c.excerpt || ''} ${c.context || ''}`;
  const s = scoreItem({ title: c.title, text, publishedAt: c.published, sourceTier: src.tier, kind: src.kind });
  const type = extra.type || (src.kind === 'cityhall' ? 'meeting' : src.kind === 'context' ? 'context' : src.kind === 'properties' ? 'property' : src.kind === 'grants' ? 'grant' : 'news');
  const tags = [...new Set([...s.tags, ...String(src.tags || '').split(',').map(t => t.trim()).filter(Boolean)])].slice(0, 4).join(',');
  const watch = type === 'context' ? null : (extra.watch || watchRule({ hits: s.hits, kind: src.kind, title: c.title }));
  const row = await env.DB.prepare(`INSERT OR IGNORE INTO items (source_id, url, title, published_at, type, tags, score, rule_hits, summary, why, raw_excerpt, summarized)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .bind(src.id, c.url, (c.title || src.name).slice(0, 220), c.published || null, type, tags, s.score, [watch, ...s.hits].filter(Boolean).join(','),
      extra.summary || null, extra.why || null, (c.excerpt || c.context || '').slice(0, 2500), extra.summary ? 1 : 0).first();
  if (!row) return null;
  await env.DB.prepare('INSERT INTO citations (item_id, url, locator) VALUES (?,?,?)').bind(row.id, c.url, extra.locator || null).run();
  if (type !== 'context' && (s.score >= 60 || watch)) {
    await env.DB.prepare('INSERT OR IGNORE INTO signals (item_id, rule_hit, score) VALUES (?,?,?)').bind(row.id, watch, s.score).run();
  }
  return row.id;
}

export async function pdfToText(env, buf) {
  if (!env.AI?.toMarkdown) return '';
  const res = await env.AI.toMarkdown({ name: 'document.pdf', blob: new Blob([buf], { type: 'application/pdf' }) });
  const one = Array.isArray(res) ? res[0] : res;
  return one?.format === 'error' ? '' : String(one?.data || '');
}

const BODY_NAMES = [['iqm2', 'City Council'], ['nrha', 'NRHA'], ['norfolkdevelopment', 'EDA']];

async function handleMeetingDoc(env, src, c, ctx) {
  // Prefer the date shown next to the link on the page (file names sometimes carry typos), else the file name.
  const fromUrl = dateFromText(c.url) || dateFromText(c.title);
  const date = c.nearDate && (!fromUrl || c.nearDate.slice(5) === fromUrl.slice(5)) ? c.nearDate : fromUrl;
  const docKind = /minutes/i.test(c.url + c.title) ? 'minutes' : 'agenda';
  const body = BODY_NAMES.find(([k]) => src.url.includes(k))?.[1] || 'Board';
  const fmt = date ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'undated';
  const title = `${body} ${docKind}: ${fmt} meeting`;

  let text = '';
  try {
    const r = await politeFetch(c.url, { maxBytes: 15_000_000 });
    text = r.isBinary ? await pdfToText(env, r.body) : stripTags(r.body);
  } catch { /* store the link even if the PDF can't be read */ }

  // Deterministic facts first (no model): dollar amounts and vote tallies.
  const amounts = [...new Set((text.match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:million|billion))?/gi) || []).map(a => a.replace(/\s+/g, ' ')))].slice(0, 8);
  const votes = [...new Set(text.match(/vote\s*:?\s*\(?\s*\d{1,2}\s*-\s*\d{1,2}(?:\s*-\s*\d{1,2})?/gi) || [])].slice(0, 8);

  let summary = null, why = null, actions = [];
  if (text.length > 200) {
    const out = await chat(env, 'extract', [
      { role: 'system', content: 'You extract facts from Norfolk, Virginia public meeting documents. Use only the document text. Copy dollar amounts and vote tallies exactly. Never guess. If a value is not in the text, use null.' },
      { role: 'user', content: `Document: ${title} (${docKind}).\nReturn JSON: {"summary":"2 sentences on what this meeting covered or decided","why":"1 sentence on why it matters for Norfolk economic development","actions":[{"item":"short name","outcome":"approved|denied|tabled|scheduled|info","amount_usd":"exact text or null","vote":"exact text or null","parties":"names of companies/projects or null"}]}\nMax 8 actions. For an agenda, outcome is "scheduled".\n\nTEXT:\n${text.slice(0, 11000)}` },
    ], { json: true, budget: ctx.budget });
    if (out?.data) {
      summary = String(out.data.summary || '').slice(0, 600) || null;
      why = String(out.data.why || '').slice(0, 300) || null;
      actions = Array.isArray(out.data.actions) ? out.data.actions.slice(0, 8) : [];
    }
  }
  if (!summary) summary = text ? `${docKind === 'minutes' ? 'Minutes' : 'Agenda'} posted.${amounts.length ? ' Amounts mentioned: ' + amounts.slice(0, 4).join(', ') + '.' : ''}${votes.length ? ' Votes recorded: ' + votes.slice(0, 3).join('; ') + '.' : ''}` : `${docKind === 'minutes' ? 'Minutes' : 'Agenda'} posted (PDF).`;

  const itemId = await insertItem(env, { ...src, kind: 'meetings' }, { url: c.url, title, published: date ? `${date}T16:00:00.000Z` : null, excerpt: text.slice(0, 2500) }, ctx,
    { type: 'meeting', summary, why, watch: 'EDA meeting document', locator: 'PDF' });
  await env.DB.prepare('INSERT OR IGNORE INTO meetings (item_id, body, doc_kind, meeting_date, doc_url, actions) VALUES (?,?,?,?,?,?)')
    .bind(itemId, body, docKind, date, c.url, JSON.stringify({ actions, amounts, votes })).run();
  return itemId;
}

/** Batch-summarize new items (8 per call). Rules already scored them; the model only nudges the ambiguous band. */
export async function summarizeNew(env, ctx) {
  const { results } = await env.DB.prepare(`SELECT i.id, i.title, i.raw_excerpt, i.score, i.type, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
     WHERE i.summarized = 0 AND i.found_at >= ? AND i.score >= 25 ORDER BY i.score DESC LIMIT 32`).bind(ctx.startedAt).all();
  for (let k = 0; k < results.length; k += 8) {
    const batch = results.slice(k, k + 8);
    const out = await chat(env, 'summarize', [
      { role: 'system', content: 'You write short, neutral summaries of Norfolk, Virginia economic development news for a civic dashboard. Use only the text provided. Never invent numbers, names or dates. Plain words.' },
      { role: 'user', content: `For each item return JSON {"items":[{"id":number,"summary":"1-2 sentences","why":"1 sentence on why it matters for Norfolk economic development, or empty string if it does not","relevance":integer from -15 to 15}]}.\n\n${JSON.stringify(batch.map(b => ({ id: b.id, source: b.source, title: b.title, text: (b.raw_excerpt || '').slice(0, 700) })))}` },
    ], { json: true, budget: ctx.budget });
    const byId = new Map((out?.data?.items || []).map(x => [Number(x.id), x]));
    const stmts = [];
    for (const b of batch) {
      const x = byId.get(b.id);
      if (x?.summary) {
        const adj = Math.max(-15, Math.min(15, Number(x.relevance) || 0));
        const score = b.score >= 30 && b.score <= 70 ? Math.max(0, Math.min(100, b.score + adj)) : b.score;
        stmts.push(env.DB.prepare('UPDATE items SET summary = ?, why = ?, score = ?, summarized = 1 WHERE id = ?').bind(String(x.summary).slice(0, 600), String(x.why || '').slice(0, 300) || null, score, b.id));
        if (score >= 60 && b.type !== 'context') stmts.push(env.DB.prepare('INSERT OR IGNORE INTO signals (item_id, rule_hit, score) VALUES (?,?,?)').bind(b.id, null, score));
      } else {
        const fallback = (b.raw_excerpt || '').replace(/\s+/g, ' ').slice(0, 240);
        stmts.push(env.DB.prepare('UPDATE items SET summary = ?, summarized = 2 WHERE id = ?').bind(fallback || null, b.id));
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
}

async function topSignals(env, sinceSql, limit) {
  const { results } = await env.DB.prepare(`SELECT i.id, i.title, i.summary, i.url, i.score, i.type, s.name AS source FROM signals g JOIN items i ON i.id = g.item_id JOIN sources s ON s.id = i.source_id
     WHERE g.status != 'dismissed' AND g.created_at >= ${sinceSql} ORDER BY i.score DESC LIMIT ?`).bind(limit).all();
  return results;
}

export async function writeDailyBrief(env, ctx) {
  let sig = await topSignals(env, "datetime('now', '-30 hours')", 10);
  if (!sig.length) {
    const { results } = await env.DB.prepare(`SELECT i.id, i.title, i.summary, i.url, i.score, i.type, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.type != 'context' AND i.found_at >= datetime('now', '-3 days') ORDER BY i.score DESC LIMIT 6`).all();
    sig = results;
  }
  if (!sig.length) return null;
  const body = await synthesize(env, ctx, sig, 'daily');
  await env.DB.prepare('INSERT INTO briefs (kind, period, body, model) VALUES (?,?,?,?) ON CONFLICT(kind, period) DO UPDATE SET body = excluded.body, model = excluded.model, created_at = datetime(\'now\')')
    .bind('daily', today(), JSON.stringify(body.content), body.model).run();
  return body.content;
}

async function writeWeekly(env, ctx) {
  const sig = await topSignals(env, "datetime('now', '-7 days')", 15);
  if (!sig.length) return null;
  const d = new Date();
  const week = isoWeek(d);
  const body = await synthesize(env, ctx, sig, 'weekly');
  await env.DB.prepare('INSERT INTO briefs (kind, period, body, model) VALUES (?,?,?,?) ON CONFLICT(kind, period) DO UPDATE SET body = excluded.body, model = excluded.model')
    .bind('weekly', week, JSON.stringify(body.content), body.model).run();
}

async function synthesize(env, ctx, sig, kind) {
  const ids = new Set(sig.map(s => s.id));
  const out = await chat(env, 'synthesize', [
    { role: 'system', content: 'You write a neutral morning briefing on Norfolk, Virginia economic development for a civic leader. Use only the items given. Every bullet must cite the item ids it is based on. Never invent facts or numbers. Plain words, under 35 words per bullet.' },
    { role: 'user', content: `Write the ${kind === 'weekly' ? 'weekly roll-up: group into themes, most important first' : "daily brief: what moved and why it matters"}. Return JSON {"bullets":[{"text":"...","items":[ids]}]} with at most ${kind === 'weekly' ? 6 : 5} bullets.\n\nITEMS:\n${JSON.stringify(sig.map(s => ({ id: s.id, source: s.source, title: s.title, summary: s.summary || '' })))}` },
  ], { json: true, budget: ctx.budget });
  const bullets = (out?.data?.bullets || [])
    .map(b => ({ text: String(b.text || '').slice(0, 400), items: (Array.isArray(b.items) ? b.items : []).map(Number).filter(i => ids.has(i)) }))
    .filter(b => b.text && b.items.length);
  if (bullets.length) return { content: { bullets, generated: 'ai' }, model: out.model };
  // Rules-only fallback: still cited, no model needed.
  return { content: { bullets: sig.slice(0, 5).map(s => ({ text: `${s.title}${s.summary ? ': ' + s.summary.slice(0, 160) : ''}`, items: [s.id] })), generated: 'rules' }, model: 'rules' };
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 864e5 + 1) / 7)).padStart(2, '0')}`;
}

async function markOk(env, src, { etag, lastModified, hash, newItems = 0 }) {
  await env.DB.prepare(`UPDATE sources SET last_fetched = datetime('now'), last_ok = datetime('now'), last_error = NULL, fail_count = 0,
      etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), last_hash = COALESCE(?, last_hash),
      last_new = CASE WHEN ? > 0 THEN datetime('now') ELSE last_new END WHERE id = ?`)
    .bind(etag || null, lastModified || null, hash || null, newItems, src.id).run();
}
