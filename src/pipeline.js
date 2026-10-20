// Daily pipeline: fetch → diff → extract → score (rules) → summarize (cheap model, batched) → signals → brief.
import { politeFetch, robustFetch, robotsAllows, sha256, extractLinks, contentLinks, parseFeed, mainText, pageTitle, pageDate,
  stripTags, dateFromText, lastDateIn, safeUrl, isoDate, today } from './util.js';
import { scoreItem, watchRule } from './score.js';
import { chat, budget as newBudget } from './llm.js';
import { refreshMetrics, refreshAwards, storeMoney } from './data.js';

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

  onProgress({ type: 'phase', phase: 'trends' });
  try { const m = await refreshMetrics(env, { force }); onProgress({ type: 'data', name: 'Trend data (FRED)', ...m }); } catch (e) { onProgress({ type: 'data', name: 'Trend data (FRED)', error: String(e.message || e) }); }
  try { const a = await refreshAwards(env, { force }); onProgress({ type: 'data', name: 'Federal awards (USAspending)', ...a }); } catch (e) { onProgress({ type: 'data', name: 'Federal awards (USAspending)', error: String(e.message || e) }); }
  onProgress({ type: 'phase', phase: 'summarizing' });
  await summarizeNew(env, ctx);
  onProgress({ type: 'phase', phase: 'brief' });
  const brief = await writeDailyBrief(env, ctx);
  try { if (await writeEdaOutlook(env, ctx, { force })) onProgress({ type: 'data', name: 'EDA Outlook (last meeting + what is next)', ok: 1 }); } catch (e) { onProgress({ type: 'data', name: 'EDA Outlook', error: String(e.message || e) }); }
  if (new Date().getUTCDay() === 1) await writeWeekly(env, ctx).catch(() => {});

  await env.DB.prepare(`UPDATE runs SET finished_at = datetime('now'), ok = ?, sources_ok = ?, sources_failed = ?, items_new = ?, llm_calls = ? WHERE id = ?`)
    .bind(ctx.failed > ctx.ok ? 0 : 1, ctx.ok, ctx.failed, ctx.newItems, ctx.budget.used, run.id).run();
  await Promise.all(['norfolk', 'region', 'state'].flatMap(g => [env.KV.delete(`dashboard:v2:${g}`), env.KV.delete(`trends:${g}`)])).catch(() => {});
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
    if (src.kind === 'reference') {
      // Linked, never fetched (robots.txt asks crawlers to stay out, or the document is too large to read).
      if (dryRun) return { ok: true, method: 'reference', candidates: [{ url, title: src.name, published: null }] };
      const added = await insertItem(env, src, { url, title: src.name, published: null, excerpt: '' }, ctx, { type: 'context', summary: 'Reference document, linked rather than read automatically.' });
      await markOk(env, src, { newItems: added ? 1 : 0 });
      return { ok: true, newItems: added ? 1 : 0 };
    }
    if (!(await robotsAllows(env, url))) throw new Error('Blocked by robots.txt');
    const firstRun = !src.last_hash;
    let r;
    try {
      r = await robustFetch(env, url, dryRun ? {} : { etag: src.etag, lastModified: src.last_modified, maxBytes: src.kind === 'context' ? 30_000_000 : 6_000_000 });
    } catch (e) {
      if (/Too large/.test(e.message) && src.kind === 'context' && !dryRun) {
        const added = await insertItem(env, src, { url, title: src.name, published: null, excerpt: '' }, ctx, { type: 'context', summary: 'Large report, linked rather than read automatically.' });
        await markOk(env, src, { newItems: added ? 1 : 0 });
        return { ok: true, newItems: added ? 1 : 0 };
      }
      throw e;
    }
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
            const p = await robustFetch(env, c.url, { maxBytes: 3_000_000 });
            if (p.isBinary) c.excerpt = (await pdfToText(env, p.body)).slice(0, 6000);
            else { c.title = pageTitle(p.body) || c.title; c.published = c.published || pageDate(p.body); c.excerpt = mainText(p.body, 6000); }
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
      extra.summary || null, extra.why || null, (c.excerpt || c.context || '').slice(0, 6000), extra.summary ? 1 : 0).first();
  if (!row) return null;
  await env.DB.prepare('INSERT INTO citations (item_id, url, locator) VALUES (?,?,?)').bind(row.id, c.url, extra.locator || null).run();
  if (type !== 'context') await storeMoney(env, row.id, `${c.title}. ${extra.moneyText || c.excerpt || ''}`).catch(() => {});
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
    const r = await robustFetch(env, c.url, { maxBytes: 15_000_000 });
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

  const itemId = await insertItem(env, { ...src, kind: 'meetings' }, { url: c.url, title, published: date ? `${date}T16:00:00.000Z` : null, excerpt: text.slice(0, 6000) }, ctx,
    { type: 'meeting', summary, why, watch: 'EDA meeting document', locator: 'PDF', moneyText: text.slice(0, 20000) });
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
    { role: 'user', content: `Write the ${kind === 'weekly' ? 'weekly roll-up: group into themes, most important first' : 'daily brief: one entry per story, most important first. Each entry is a plain 1-2 sentence summary of that story and why it matters'}. Return JSON {"bullets":[{"text":"...","items":[ids]}]} with at most ${kind === 'weekly' ? 6 : 6} entries. Do not repeat the same story twice.\n\nITEMS:\n${JSON.stringify(sig.map(s => ({ id: s.id, source: s.source, title: s.title, summary: s.summary || '' })))}` },
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

/**
 * EDA Outlook: reads the latest EDA agendas/minutes (plus EDA-related news) and writes
 * (1) what happened at the last meeting, (2) initiatives in motion, (3) topics likely on upcoming agendas.
 * Upcoming topics are inferences and are labeled that way; every line cites the documents it rests on.
 */
export async function writeEdaOutlook(env, ctx, { force = false } = {}) {
  const prev = await env.DB.prepare("SELECT created_at FROM briefs WHERE kind = 'eda_outlook' ORDER BY id DESC LIMIT 1").first();
  const fresh = await env.DB.prepare(`SELECT COUNT(*) n FROM meetings WHERE body = 'EDA' AND created_at >= ?`).bind(ctx.startedAt).first('n');
  const stale = !prev || Date.now() - Date.parse(prev.created_at.replace(' ', 'T') + 'Z') > 7 * 864e5;
  if (!force && !fresh && !stale) return false;
  const { results: docs } = await env.DB.prepare(`SELECT m.doc_kind, m.meeting_date, m.actions, i.id, i.title, i.summary, i.raw_excerpt FROM meetings m JOIN items i ON i.id = m.item_id
      WHERE m.body = 'EDA' ORDER BY m.meeting_date DESC, m.id DESC LIMIT 5`).all();
  const { results: news } = await env.DB.prepare(`SELECT i.id, i.title, i.summary FROM items i
      WHERE i.type != 'context' AND i.found_at >= datetime('now','-60 days') AND (LOWER(i.title || ' ' || COALESCE(i.summary,'')) LIKE '%economic development%' OR LOWER(i.title || ' ' || COALESCE(i.summary,'')) LIKE '%eda%')
      ORDER BY i.score DESC LIMIT 8`).all();
  if (!docs.length) return false;
  const ids = new Set([...docs, ...news].map(x => x.id));
  const material = docs.map(d => {
    const a = safeJson(d.actions) || {};
    return `[${d.id}] EDA ${d.doc_kind} for ${d.meeting_date || 'unknown date'}\nSummary: ${d.summary || ''}\nActions: ${JSON.stringify((a.actions || []).slice(0, 8))}\nAmounts: ${(a.amounts || []).join(', ')}\nText: ${(d.raw_excerpt || '').replace(/\s+/g, ' ').slice(0, 2200)}`;
  }).join('\n\n') + (news.length ? `\n\nRelated news:\n${news.map(n => `[${n.id}] ${n.title}. ${n.summary || ''}`).join('\n')}` : '');
  const out = await chat(env, 'synthesize', [
    { role: 'system', content: 'You are a careful civic analyst for Norfolk, Virginia. Use only the documents given. Copy dollar amounts and votes exactly. Clearly separate facts (what documents say) from inferences (what is likely next). Never invent names, numbers or dates. Plain words.' },
    { role: 'user', content: `From these Norfolk Economic Development Authority (EDA) agendas, minutes and related news, return JSON:
{"last_meeting":{"date":"YYYY-MM-DD or null","summary":"2-3 sentences on what the most recent meeting covered","decisions":[{"text":"one line, include exact amount/vote if stated","ids":[doc ids]}]},
 "initiatives":[{"name":"short name","status":"one line on where it stands","ids":[doc ids]}],
 "upcoming":[{"topic":"short topic","why":"one line: which document points to it (e.g. tabled, follow-up requested, recurring report, pending agreement)","confidence":"likely|possible","ids":[doc ids]}]}
Max 6 decisions, 5 initiatives, 5 upcoming topics. Upcoming topics must come from evidence such as items tabled, deferred, scheduled for follow-up, recurring monthly reports, or agreements pending approval.

DOCUMENTS:
${material}` },
  ], { json: true, budget: ctx.budget, maxTokens: 1100 });
  const d = out?.data;
  if (!d || !d.last_meeting) return false;
  const clean = arr => (Array.isArray(arr) ? arr : []).map(x => ({ ...x, ids: (Array.isArray(x.ids) ? x.ids : []).map(Number).filter(i => ids.has(i)) }));
  const body = {
    last_meeting: { date: d.last_meeting.date || docs[0].meeting_date, summary: String(d.last_meeting.summary || '').slice(0, 700), decisions: clean(d.last_meeting.decisions).slice(0, 6) },
    initiatives: clean(d.initiatives).slice(0, 5),
    upcoming: clean(d.upcoming).filter(u => u.topic).slice(0, 5).map(u => ({ ...u, confidence: u.confidence === 'likely' ? 'likely' : 'possible' })),
    docs: docs.map(x => ({ id: x.id, title: x.title, date: x.meeting_date, kind: x.doc_kind })),
  };
  await env.DB.prepare('INSERT INTO briefs (kind, period, body, model) VALUES (?,?,?,?) ON CONFLICT(kind, period) DO UPDATE SET body = excluded.body, model = excluded.model, created_at = datetime(\'now\')')
    .bind('eda_outlook', new Date().toISOString().slice(0, 10), JSON.stringify(body), out.model).run();
  return true;
}
const safeJson = s => { try { return JSON.parse(s); } catch { return null; } };
