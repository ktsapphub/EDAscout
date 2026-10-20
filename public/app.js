// EDAScout front end. Open to everyone; the edit key is asked for only when changing sources or settings.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const GEO_NAMES = { norfolk: 'Norfolk', region: 'Hampton Roads', state: 'Virginia' };
let geo = ['norfolk', 'region', 'state'].includes(store.get('geo')) ? store.get('geo') : 'norfolk';
let dash = null, trendData = null, filter = 'All', trendGroup = 'All', trendKey = null;

// ---------------- helpers ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { status: res.status, code: data.error });
  return data;
}
/** Run an edit action; if the server wants the edit key, ask once, then retry. */
async function edit(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.code !== 'edit-key') throw e;
    if (!(await askKey())) throw new Error('Edit cancelled');
    return fn();
  }
}
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), action ? 8000 : 3500);
}
const toDate = d => !d ? null : new Date(d.length === 10 ? d + 'T12:00:00Z' : (d.includes('T') ? d : d.replace(' ', 'T') + 'Z'));
const fmtDate = d => d ? toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: d.length === 10 ? 'UTC' : undefined }) : '';
const ago = d => {
  if (!d) return 'never';
  const m = Math.round((Date.now() - toDate(d)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const favicon = url => { try { return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`; } catch { return ''; } };
const isFresh = d => d && Date.now() - toDate(d) < 30 * 3600e3;
function money(v) {
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`;
}
function fmtVal(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  if (unit === '$') return v >= 1e5 ? `$${Math.round(v / 1000).toLocaleString('en-US')}K` : `$${Math.round(v).toLocaleString('en-US')}`;
  if (unit === '$M') return v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${Math.round(v).toLocaleString('en-US')}M`;
  if (unit === '%') return `${v.toFixed(1)}%`;
  if (unit === 'k') return v >= 1000 ? `${(v / 1000).toFixed(2)}M` : `${v.toFixed(1)}k`;
  if (unit === 'days') return `${Math.round(v)} days`;
  if (unit === 'idx') return v.toFixed(0);
  return Math.round(v).toLocaleString('en-US');
}
function countUp(el, to, fmt = v => Math.round(v)) {
  if (reduce || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), from = 0;
  const step = t => { const p = Math.min(1, (t - t0) / 900); el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const swap = render => (document.startViewTransition && !reduce) ? document.startViewTransition(render) : render();
function reveal() {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
  $$('.reveal').forEach(z => { $$('.panel, .kpis, .metric', z).forEach((p, i) => p.style.setProperty('--i', i)); io.observe(z); });
}
function setStatus(kind, text) { const s = $('#runStatus'); s.querySelector('.dot').className = `dot ${kind}`; s.querySelector('.txt').textContent = text; }

// ---------------- geography switch ----------------
function placePill() {
  const btn = $(`.scope [data-geo="${geo}"]`), pill = $('.scope-pill');
  if (!btn) return;
  pill.style.width = btn.offsetWidth + 'px';
  pill.style.transform = `translateX(${btn.offsetLeft - 3}px)`;
}
$$('.scope button').forEach(b => b.onclick = () => {
  if (b.dataset.geo === geo) return;
  geo = b.dataset.geo; store.set('geo', geo);
  $$('.scope button').forEach(x => x.setAttribute('aria-checked', x === b));
  placePill();
  dash = null; trendData = null; trendKey = null;
  if (location.hash.replace(/^#\/?/, '') === '' ) renderDashboard(true); else location.hash = '#/';
});
addEventListener('resize', placePill);
document.fonts?.ready.then(placePill);
$$('.scope button').forEach(x => x.setAttribute('aria-checked', x.dataset.geo === geo));

// ---------------- router ----------------
async function router() {
  const r = location.hash.replace(/^#\/?/, '') || 'home';
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r));
  placePill();
  if (r === 'sources') return renderSources();
  if (r === 'models') return renderModels();
  return renderDashboard();
}
addEventListener('hashchange', router);

// ---------------- dashboard ----------------
function skeleton() {
  const sk = n => Array.from({ length: n }, (_, i) => `<div class="sk" style="width:${92 - i * 9}%"></div>`).join('');
  return `<div class="zone"><div class="divider"><span>Today</span></div><div class="grid"><div class="span-12 kpis">${'<div class="kpi"><div class="sk" style="height:28px;width:50%"></div><div class="sk" style="width:70%"></div></div>'.repeat(4)}</div>
    <section class="panel brief span-12"><div class="panel-head"><h2>Today's Brief</h2></div><div class="panel-body">${sk(4)}</div></section></div></div>
    <div class="zone"><div class="divider"><span>Trends</span></div><div class="metrics">${'<div class="metric"><div class="sk" style="width:60%"></div><div class="sk" style="height:24px;width:40%"></div><div class="sk" style="height:40px"></div></div>'.repeat(4)}</div></div>`;
}

async function renderDashboard(geoChange = false) {
  if (!dash) app.innerHTML = skeleton();
  try { [dash, trendData] = await Promise.all([api(`/api/dashboard?geo=${geo}`), api(`/api/trends?geo=${geo}`)]); }
  catch (e) { app.innerHTML = `<p class="empty">Couldn't load the dashboard: ${esc(e.message)}</p>`; return; }
  swap(() => drawDashboard(dash));
  ticker(dash.latest);
  // No one should have to press a button for fresh data: if the last update is old (missed schedule), refresh in the background.
  const run = dash.lastRun;
  if (!scanning && (!run || (run.finished_at && hoursSince(run.finished_at) > 7) || run.stale)) backgroundScan();
  if (geoChange) toast(`Showing ${GEO_NAMES[geo]}`);
}

function ticker(list) {
  const items = (list || []).slice(0, 14);
  if (!items.length) { $('#ticker').innerHTML = ''; return; }
  const html = items.map(r => `<a href="#" data-story="${r.id}"><b>${esc(r.source.split(/[(:]/)[0].trim().slice(0, 22))}</b>${esc(r.title.slice(0, 110))}</a>`).join('');
  $('#ticker').innerHTML = html + html.replace(/<a /g, '<a aria-hidden="true" tabindex="-1" ');
  $$('#ticker [data-story]').forEach(a => a.onclick = e => { e.preventDefault(); openStory(+a.dataset.story); });
}

function drawDashboard(d) {
  const run = d.lastRun;
  if (scanning) setStatus('live', 'Refreshing sources…');
  else if (!run) setStatus('idle', 'No update yet');
  else if (!run.finished_at && !run.stale) setStatus('live', 'Refreshing sources…');
  else setStatus(run.ok ? '' : 'bad', `Updated ${ago(run.finished_at || run.started_at)}`);
  startRefreshClock(d);
  const g = GEO_NAMES[geo], B = buildBrief(d, trendData?.metrics || []);
  const eda = edaZone(d);

  const sections = {
    today: { title: `Today · ${g}`, body: `<div class="grid"><div class="span-12 kpis">${kpiRow(d, B)}</div>${briefPanel(d, B)}</div>` },
    eda: { title: 'EDA Board Meetings', small: 'Norfolk Economic Development Authority · agendas &amp; minutes', body: eda },
    trends: { title: `Trends · ${g}`, small: 'Source: FRED · tap a card for the full chart', body: trendsBlock() },
    signals: { title: `Signals · ${g}`, small: 'Scored 0–100 for relevance to Norfolk economic development', body: `<div class="grid">
      <section class="panel span-12 ${d.signals.some(s => isFresh(s.found_at)) ? 'has-new' : ''}">
        <div class="panel-head"><h2>${ico('radar')}Signal Board</h2><span class="meta">${d.signals.length} active · ${g}</span></div>
        ${scoreHistogram(d.signals)}
        <div class="filters" role="toolbar" aria-label="Filter signals">${['All', ...new Set(d.signals.flatMap(s => (s.tags || '').split(',').filter(Boolean)))].slice(0, 9).map(t => `<button class="chip ${t === filter ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="panel-body flush scroll"><div class="cards two" id="signalCards">${signalCards(d.signals)}</div></div>
      </section></div>` },
    money: { title: `Money &amp; Housing · ${g}`, small: 'Dollar figures found in sources · federal awards in Norfolk', body: `<div class="grid">${moneyPanel(d)}${awardsPanel(d)}</div>` },
    cityhall: { title: 'City Hall &amp; Latest', body: `<div class="grid">
      <section class="panel span-6"><div class="panel-head"><h2>${ico('hall')}Norfolk City Hall</h2><span class="meta">Council, Planning &amp; boards</span></div>
        <div class="panel-body flush">${d.cityhall.length ? `<ul class="rows">${d.cityhall.map(r => `<li><button class="linkbtn" data-story="${r.id}">${esc(r.title)}</button><span class="s">${esc(r.summary || '')}${r.summary ? ' · ' : ''}found ${ago(r.found_at)}</span></li>`).join('')}</ul>` : '<p class="empty" style="padding:16px">No City Hall items in the latest update.</p>'}</div></section>
      <section class="panel span-6"><div class="panel-head"><h2>${ico('feed')}Latest from all sources</h2><span class="meta">${g} · newest first</span></div>
        <div class="panel-body flush scroll" style="max-height:520px">${d.latest.length ? `<ul class="rows">${d.latest.map(r => `<li><button class="linkbtn" data-story="${r.id}">${esc(r.title)}</button><span class="s"><span class="src"><img src="${favicon(r.url)}" alt="" loading="lazy"> ${esc(r.source)}</span> · ${ago(r.found_at)}</span></li>`).join('')}</ul>` : '<p class="empty" style="padding:16px">Nothing yet.</p>'}</div></section>
    </div>` },
    topics: { title: "What's heating up", small: 'Items per topic, last 8 weeks', body: `<div class="grid">
      <section class="panel span-5"><div class="panel-head"><h2>${ico('trend')}Topic momentum</h2><span class="meta">green = this week</span></div>
        <div class="panel-body flush">${topicsList(d.topics)}</div></section>
      <section class="panel span-7"><div class="panel-head"><h2>${ico('book')}Plans &amp; research library</h2><span class="meta">context, not news</span></div>
        <div class="lib">${d.library.map(r => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title.slice(0, 90))}<span>${esc(r.source)}</span></a>`).join('') || '<p class="empty">Loads after the first update.</p>'}</div></section>
    </div>` },
  };
  if (d.weekly) sections.weekly = { title: `Weekly Roll-up · ${esc(d.weekly.period)}`, body: `<div class="grid"><section class="panel span-12"><div class="panel-body"><div class="stories">${d.weekly.bullets.map((b, i) => storyCard(b, i, d)).join('')}</div></div></section></div>` };
  const L = layout(), order = [...L.order.filter(k => sections[k]), ...Object.keys(sections).filter(k => !L.order.includes(k))];
  const visible = order.filter(k => !L.hidden.includes(k));
  app.innerHTML = visible.map((k, i) => zone(k, sections[k], L.collapsed.includes(k), i, visible.length)).join('')
    + `<div class="layout-bar">${L.hidden.filter(k => sections[k]).length ? `<span>Hidden:</span>${L.hidden.filter(k => sections[k]).map(k => `<button class="chip" data-unhide="${k}">+ ${sections[k].title.replace(/ · .*/, '')}</button>`).join('')}` : '<span class="muted">Use the controls on each section bar to move, collapse or hide it.</span>'}<button class="linkbtn" id="resetLayout">Reset layout</button></div>`;
  $$('[data-count]').forEach(el => countUp(el, +el.dataset.count));
  $$('[data-money]').forEach(el => countUp(el, +el.dataset.money, money));
  requestAnimationFrame(() => $$('.kpi [data-w]').forEach(el => (el.style.width = el.dataset.w + '%')));
  wireDashboard(d, B);
  wireLayout();
  reveal();
}

// ---------------- brief: built from what is on the page, per area ----------------
const pickM = (ms, k) => ms.find(m => m.key === k);
const firstSentence = t => (String(t || '').match(/^.*?[.!?](\s|$)/)?.[0] || String(t || '')).trim();
const USELESS = /does not provide|no relevant text|not provided in|unable to (?:determine|summari)/i;
function chgWords(m) {
  if (m.change == null) return '';
  if (m.unit === '%') return Math.abs(m.change) < 0.05 ? 'flat vs. a year ago' : `${m.change > 0 ? 'up' : 'down'} ${Math.abs(m.change).toFixed(1)} pts vs. a year ago`;
  return Math.abs(m.pct) < 0.05 ? 'flat vs. a year ago' : `${m.pct > 0 ? 'up' : 'down'} ${Math.abs(m.pct).toFixed(1)}% vs. a year ago`;
}
const metricLine = m => `${m.label} ${fmtVal(m.latest.v, m.unit)}${chgWords(m) ? ', ' + chgWords(m) : ''}`;
const direction = m => m.change == null || m.better === 'neutral' || Math.abs(m.pct ?? m.change) < 0.05 ? 0 : (m.change > 0) === (m.better === 'up') ? 1 : -1;

function buildBrief(d, ms) {
  const g = GEO_NAMES[geo];
  const dir = ms.filter(m => m.better !== 'neutral' && m.change != null);
  const up = dir.filter(m => direction(m) === 1), down = dir.filter(m => direction(m) === -1);
  const keyOrder = geo === 'norfolk' ? ['unemp', 'list_price', 'income', 'gdp'] : ['unemp', 'jobs', 'gdp', 'list_price', 'permits'];
  const keyMetrics = keyOrder.map(k => pickM(ms, k)).filter(Boolean);
  const dataSyn = ms.length
    ? `${dir.length ? `Of ${dir.length} indicators with a clear good-or-bad direction, ${up.length} improved and ${down.length} weakened over the past year. ` : ''}${keyMetrics.slice(0, 3).map(metricLine).join('; ')}.`
    : `Trend data for ${g} loads with the next update.`;

  const sigs = d.signals, fresh = sigs.filter(s => isFresh(s.found_at)).length;
  const ranked = [...sigs].sort((a, b) => b.score - a.score);
  const top85 = ranked.filter(s => s.score >= 85).slice(0, 6);
  const closest = top85.length ? [] : ranked.slice(0, 3);

  const totals = d.money.totals || [], total = totals.reduce((a, t) => a + t.total, 0), mentions = totals.reduce((a, t) => a + t.n, 0);
  const lp = pickM(ms, 'list_price'), dom = pickM(ms, 'dom');
  const wk = d.latest.filter(r => Date.now() - toDate(r.found_at) < 7 * 864e5).length;
  const hot = (d.topics?.list || []).map(t => ({ tag: t.tag, now: t.weeks.at(-1) || 0, prev: t.weeks.at(-2) || 0, total: t.total })).sort((a, b) => b.now - a.now || b.total - a.total)[0];

  const areas = [
    { id: 'trends', icon: 'trend', label: 'Trends', line: ms.length ? `${dir.length ? `${up.length} of ${dir.length} indicators improved over the year. ` : ''}${keyMetrics[0] ? metricLine(keyMetrics[0]) + '.' : ''}` : 'Trend data loads with the next update.' },
    { id: 'signals', icon: 'radar', label: 'Signals', line: sigs.length ? `${sigs.length} active signal${sigs.length > 1 ? 's' : ''}, ${fresh} new in the last day. Strongest: “${ranked[0].title.slice(0, 90)}” (score ${ranked[0].score}).` : `No active signals for ${g} yet.` },
    { id: 'money', icon: 'coin', label: 'Money & Housing', line: `${total ? `${money(total)} in dollar figures across ${mentions} mention${mentions > 1 ? 's' : ''} in the last 90 days, mostly ${totals[0].kind}. ` : 'No dollar figures in recent stories. '}${lp ? `Median list price ${fmtVal(lp.latest.v, lp.unit)}${chgWords(lp) ? ', ' + chgWords(lp) : ''}` : ''}${dom ? `; homes sell in a median ${fmtVal(dom.latest.v, dom.unit)}` : ''}${lp || dom ? '.' : ''}` },
    { id: 'cityhall', icon: 'hall', label: 'City Hall & Latest', line: `${wk} stor${wk === 1 ? 'y' : 'ies'} found in the past week.${d.cityhall.length ? ` Latest from Norfolk City Hall: “${d.cityhall[0].title.slice(0, 80)}”.` : ''}` },
    { id: 'topics', icon: 'book', label: "What's heating up", line: hot && hot.now ? `${hot.tag} leads this week with ${hot.now} item${hot.now > 1 ? 's' : ''}${hot.prev ? ` (${hot.prev} the week before)` : ''}.` : hot ? `Quiet week so far. ${hot.tag} is the busiest topic over 8 weeks (${hot.total} items).` : 'Builds up as items arrive.' },
  ];
  const nextEda = d.kpis.nextEda, edaDays = nextEda ? Math.max(0, Math.ceil((toDate(nextEda) - Date.now()) / 864e5)) : null;
  const lastMtg = d.outlook?.last_meeting;
  if (geo === 'norfolk') areas.unshift({ id: 'eda', icon: 'cal', label: 'EDA Board', line: `${edaDays != null ? `Next meeting ${fmtDate(nextEda)}, in ${edaDays} day${edaDays === 1 ? '' : 's'}. ` : ''}${lastMtg?.summary ? `Last meeting (${fmtDate(lastMtg.date)}): ${firstSentence(noIds(lastMtg.summary))}` : ''}` });
  const synopsis = d.overview?.text ? noIds(d.overview.text) : dataSyn;
  return { g, ms, dir, up, down, keyMetrics, dataSyn, synopsis, aiSynopsis: !!d.overview?.text, top85, closest, areas, nextEda, edaDays };
}

function kpiRow(d, B) {
  const healthy = d.health?.ok || 0, total = (d.health?.ok || 0) + (d.health?.failing || 0) + (d.health?.pending || 0);
  if (geo === 'norfolk') return `
    <div class="kpi"><div class="n" data-count="${B.edaDays ?? 0}">0</div><div class="l">Days until the next EDA meeting · ${B.nextEda ? fmtDate(B.nextEda) : '—'}</div></div>
    <div class="kpi"><div class="n" data-count="${d.kpis.new_signals || 0}">0</div><div class="l">New signals in the last day</div></div>
    <div class="kpi"><div class="n" data-money="${(d.money.totals || []).reduce((a, t) => a + t.total, 0)}">$0</div><div class="l">Dollars mentioned in sources (90 days)</div></div>
    <div class="kpi"><div class="n" data-count="${healthy}">0</div><div class="l">Sources reading cleanly of ${total}</div><div class="bar"><i data-w="${total ? Math.round(healthy / total * 100) : 0}"></i></div></div>`;
  const tile = k => { const m = pickM(B.ms, k); return m ? `<div class="kpi"><div class="n">${fmtVal(m.latest.v, m.unit)}</div><div class="l">${esc(m.label)}${chgWords(m) ? ` · <span class="chg ${['flat', 'good', 'bad'][[0, 1, -1].indexOf(direction(m))]}">${esc(chgWords(m))}</span>` : ''}</div></div>` : ''; };
  return ['unemp', 'jobs', 'gdp', 'list_price'].map(tile).join('') || '<div class="kpi"><div class="l">Trend data loads with the next update.</div></div>';
}

function sigStory(s, i) {
  return `<article class="story" style="animation-delay:${i * 70}ms" data-say="sig${i}">
    <span class="num">${s.score}</span>
    <h3>${esc(s.title.slice(0, 140))}</h3>
    <p>${esc(storySummary(s, s.why || ''))}</p>
    <div class="row"><span class="src">${esc(s.source)}${s.published_at ? ' · ' + fmtDate(s.published_at) : ''}</span><button class="read" data-story="${s.id}">Read story ↗</button></div>
  </article>`;
}

function briefPanel(d, B) {
  const top = B.top85.length
    ? `<div class="stories">${B.top85.map(sigStory).join('')}</div>`
    : `<p class="note">No story scored 85 or higher for ${B.g} in this update.${B.closest.length ? ' Closest to the bar:' : ''}</p>${B.closest.length ? `<div class="stories dim">${B.closest.map(sigStory).join('')}</div>` : ''}`;
  const lead = geo === 'norfolk'
    ? `<div class="lead-chip"><div class="big" data-count="${B.edaDays ?? 0}">0</div><div><b>day${B.edaDays === 1 ? '' : 's'} until the next EDA meeting</b><span>${B.nextEda ? fmtDate(B.nextEda) : ''} · 12:00 PM · 999 Waterside Dr.</span><button class="jump" data-jump="eda">See EDA meetings ↓</button></div></div>`
    : `<div class="lead-chip"><div class="big">${B.up.length}<small>/${B.dir.length}</small></div><div><b>indicators improved over the year</b><span>${B.g} · Federal Reserve (FRED) data</span><button class="jump" data-jump="trends">See trends ↓</button></div></div>`;
  return `<section class="panel brief span-12">
    <div class="panel-head"><h2>Today's Brief · ${B.g}</h2>
      <span class="meta">${fmtDate(new Date().toISOString().slice(0, 10))} · ${B.aiSynopsis ? 'AI synopsis of this page' : 'summary of this page'}</span>
      <button class="listen" id="listen"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span class="wave"><i></i><i></i><i></i><i></i></span><span class="lt">Listen</span></button>
    </div>
    <div class="panel-body">
      <div class="brief-top">${lead}<div class="synopsis" data-say="syn"><h4>Synopsis</h4><p>${esc(B.synopsis)}</p></div></div>
      <h4 class="bh"><span>Top signals · score 85+</span></h4>${top}
      <h4 class="bh"><span>Area by area</span></h4>
      <ol class="areas">${B.areas.map((a, i) => `<li data-say="area${i}" style="--i:${i}"><span class="ai">${ico(a.icon)}</span><div><b>${esc(a.label)}</b><p>${esc(a.line)}</p></div><button class="jump" data-jump="${a.id}" aria-label="Go to ${esc(a.label)}">View ↓</button></li>`).join('')}</ol>
      ${B.keyMetrics.length ? `<h4 class="bh"><span>The numbers</span></h4><div class="nums">${B.keyMetrics.map(m => `<div class="num-chip"><span>${esc(m.label)}</span><b>${fmtVal(m.latest.v, m.unit)}</b><i class="chg ${['flat', 'good', 'bad'][[0, 1, -1].indexOf(direction(m))]}">${esc(chgWords(m) || fmtDate(m.latest.d))}</i></div>`).join('')}</div>` : ''}
    </div>
  </section>`;
}

function briefSpeech(B) {
  const parts = [{ say: null, text: `Here is your ${B.g} economic development brief.` }];
  if (geo === 'norfolk' && B.edaDays != null) parts.push({ say: null, text: `The next E.D.A. meeting is ${fmtDate(B.nextEda)}, ${B.edaDays} days from now.` });
  parts.push({ say: 'syn', text: B.synopsis });
  if (B.top85.length) B.top85.forEach((s, i) => parts.push({ say: `sig${i}`, text: `Top signal, score ${s.score}. ${s.title}. ${storySummary(s, '')}` }));
  else parts.push({ say: null, text: 'No story scored 85 or higher in this update.' });
  B.areas.forEach((a, i) => parts.push({ say: `area${i}`, text: `${a.label}. ${a.line}` }));
  return parts;
}

// ---------------- EDA board meetings ----------------
function meetingGroups(d) {
  const by = new Map();
  for (const m of d.meetings) {
    const k = m.meeting_date || m.created_at?.slice(0, 10) || 'undated';
    if (!by.has(k)) by.set(k, { date: m.meeting_date, docs: [] });
    by.get(k).docs.push(m);
  }
  return [...by.values()].map(gp => {
    const order = ['minutes', 'agenda'];
    gp.docs.sort((a, b) => order.indexOf(a.doc_kind) - order.indexOf(b.doc_kind));
    const good = gp.docs.find(x => x.summary && !USELESS.test(x.summary));
    gp.synopsis = good ? noIds(good.summary) : 'The documents for this meeting could not be read automatically. Open the PDF for details.';
    gp.from = good?.doc_kind || '';
    gp.past = gp.date ? toDate(gp.date) < Date.now() : true;
    const seen = new Set();
    gp.actions = gp.docs.flatMap(x => (x.actions?.actions || []).filter(a => a.item)).filter(a => { const k = a.item.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
    gp.detailId = (good || gp.docs[0]).id;
    return gp;
  });
}
function meetingSpeech(gp) {
  return `E.D.A. meeting, ${gp.date ? fmtDate(gp.date) : 'undated'}. ${gp.synopsis} ${gp.actions.length ? 'Items: ' + gp.actions.map(a => a.item + (val(a.outcome) ? `, ${a.outcome}` : '')).join('. ') + '.' : ''}`;
}
function outlookSpeech(o) {
  if (!o) return 'The E.D.A. outlook is not available yet.';
  const lm = o.last_meeting || {};
  return [`E.D.A. outlook.`, lm.summary ? `Last meeting, ${fmtDate(lm.date)}: ${noIds(lm.summary)}` : '',
    o.initiatives?.length ? `In motion: ${o.initiatives.map(x => `${x.name}. ${noIds(x.status)}`).join(' ')}` : '',
    o.upcoming?.length ? `Likely on upcoming agendas: ${o.upcoming.map(x => `${x.topic}, ${x.confidence}`).join('; ')}.` : ''].filter(Boolean).join(' ');
}

function edaZone(d) {
  const nextEda = d.kpis.nextEda, dt = nextEda ? toDate(nextEda) : null;
  const days = dt ? Math.max(0, Math.ceil((dt - Date.now()) / 864e5)) : null;
  const groups = meetingGroups(d);
  return `<div class="grid">
      <section class="panel span-4 next-card">
        <div class="panel-head"><h2>${ico('cal')}Next meeting</h2></div>
        <div class="panel-body">
          ${dt ? `<div class="nm"><div class="cal"><div class="m">${dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</div><div class="d">${dt.getUTCDate()}</div></div>
            <div><div class="days"><b data-count="${days}">0</b> day${days === 1 ? '' : 's'} away</div><div class="muted">${dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })} · 12:00 PM<br>999 Waterside Dr., Suite 400<br>Budget committee 11:15 AM</div></div></div>` : '<p class="muted">Date not posted yet.</p>'}
          <div class="nm-actions"><button class="btn" data-speak="outlook">▶ Listen to the outlook</button>
          <a class="btn" href="https://norfolkdevelopment.com/target-industries/the-norfolk-economic-development-authority/" target="_blank" rel="noopener">EDA page ↗</a></div>
          <p class="muted" style="font-size:12px;margin:10px 0 0">First Wednesday of each month. Confirm on the EDA page before attending.</p>
        </div>
      </section>
      ${outlookPanel(d, 'span-8')}
      <section class="panel span-12"><div class="panel-head"><h2>${ico('book')}Previous meetings</h2><span class="meta">${groups.length} meeting${groups.length === 1 ? '' : 's'} · quick synopsis · tap Listen to hear it</span></div>
        <div class="panel-body">${groups.length ? `<div class="mtgs">${groups.map((gp, i) => {
          const t = gp.date ? toDate(gp.date) : null;
          return `<article class="mtg" style="--i:${i}">
            <div class="mtg-date">${t ? `<span class="m">${t.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span><span class="d">${t.getUTCDate()}</span><span class="y">${t.getUTCFullYear()}</span>` : '<span class="m">—</span>'}</div>
            <div class="mtg-body">
              <div class="mtg-docs">${gp.docs.map(x => `<a class="doc ${esc(x.doc_kind)}" href="${esc(x.doc_url)}" target="_blank" rel="noopener">${esc(x.doc_kind === 'minutes' ? 'Minutes' : 'Agenda')} PDF ↗</a>`).join('')}${gp.from ? `<span class="muted">synopsis from the ${esc(gp.from)}</span>` : ''}</div>
              <p>${esc(gp.synopsis)}</p>
              ${gp.actions.length ? `<ul>${gp.actions.map(a => `<li>${esc(a.item)}${val(a.outcome) ? ` · <i>${esc(a.outcome)}</i>` : ''}${val(a.amount_usd) ? ` <span class="amtchip">${esc(a.amount_usd)}</span>` : ''}${val(a.vote) ? ` <span class="amtchip">vote ${esc(a.vote)}</span>` : ''}</li>`).join('')}</ul>` : ''}
              <div class="mtg-actions"><button class="btn sm" data-speak="mtg${i}">▶ Listen</button><button class="linkbtn" data-story="${gp.detailId}">Full details</button></div>
            </div>
          </article>`; }).join('')}</div>` : '<p class="empty">Agendas and minutes appear after the next update reads the EDA site.</p>'}</div>
      </section>
    </div>`;
}


// ---------------- layout: move, collapse, hide (remembered on this device) ----------------
const DEFAULT_ORDER = ['today', 'eda', 'trends', 'signals', 'money', 'cityhall', 'topics', 'weekly'];
function layout() {
  let L = null;
  try { L = JSON.parse(store.get('layout:' + geo) || 'null'); } catch {}
  const base = geo === 'norfolk' ? DEFAULT_ORDER : ['today', 'trends', 'signals', 'money', 'eda', 'cityhall', 'topics', 'weekly'];
  return { order: L?.order?.length ? L.order : base, hidden: L?.hidden || [], collapsed: L?.collapsed || [] };
}
const saveLayout = L => store.set('layout:' + geo, JSON.stringify(L));
function zone(k, sec, collapsed, i, n) {
  const ctl = (act, label, icon, dis) => `<button class="zc" data-zone="${k}" data-zact="${act}" aria-label="${label}" title="${label}"${dis ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></button>`;
  return `<section class="zone reveal ${collapsed ? 'collapsed' : ''}" id="${k}">
    <div class="divider"><span>${sec.title}</span>${sec.small ? `<small>${sec.small}</small>` : ''}
      <div class="zctl">${ctl('up', 'Move section up', '<path d="M6 15l6-6 6 6"/>', i === 0)}${ctl('down', 'Move section down', '<path d="M6 9l6 6 6-6"/>', i === n - 1)}${ctl('collapse', collapsed ? 'Expand section' : 'Collapse section', collapsed ? '<path d="M4 12h16M12 4v16"/>' : '<path d="M4 12h16"/>')}${ctl('hide', 'Hide section', '<path d="M6 6l12 12M18 6L6 18"/>')}</div></div>
    <div class="zone-body" ${collapsed ? 'hidden' : ''}>${sec.body}</div>
  </section>`;
}
function wireLayout() {
  $$('[data-zact]').forEach(b => b.onclick = () => {
    const k = b.dataset.zone, act = b.dataset.zact, L = layout();
    const vis = [...L.order.filter(x => $('#' + x) || x === k)];
    if (!L.order.includes(k)) L.order.push(k);
    const domOrder = $$('#app > .zone').map(z => z.id);
    L.order = [...domOrder, ...L.order.filter(x => !domOrder.includes(x))];
    const i = L.order.indexOf(k);
    if (act === 'up' || act === 'down') {
      const vi = domOrder.indexOf(k), other = domOrder[vi + (act === 'up' ? -1 : 1)];
      if (!other) return;
      const j = L.order.indexOf(other); [L.order[i], L.order[j]] = [L.order[j], L.order[i]];
      saveLayout(L);
      const el = $('#' + k), oel = $('#' + other);
      swap(() => { act === 'up' ? oel.before(el) : oel.after(el); refreshZoneButtons(); });
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    } else if (act === 'collapse') {
      const on = !L.collapsed.includes(k);
      L.collapsed = on ? [...L.collapsed, k] : L.collapsed.filter(x => x !== k);
      saveLayout(L);
      const z = $('#' + k); z.classList.toggle('collapsed', on); $('.zone-body', z).hidden = on;
      b.setAttribute('aria-label', on ? 'Expand section' : 'Collapse section'); b.title = b.getAttribute('aria-label');
      b.querySelector('svg').innerHTML = on ? '<path d="M4 12h16M12 4v16"/>' : '<path d="M4 12h16"/>';
      if (!on && k === 'trends') drawTrendCards();
    } else if (act === 'hide') {
      L.hidden = [...new Set([...L.hidden, k])]; saveLayout(L);
      const z = $('#' + k); z.style.transition = 'opacity .25s, transform .25s'; z.style.opacity = 0; z.style.transform = 'scale(.98)';
      setTimeout(() => drawDashboard(dash), 250);
      toast('Section hidden', { label: 'Undo', run: () => { const M = layout(); M.hidden = M.hidden.filter(x => x !== k); saveLayout(M); drawDashboard(dash); } });
    }
  });
  $$('[data-unhide]').forEach(b => b.onclick = () => { const L = layout(); L.hidden = L.hidden.filter(x => x !== b.dataset.unhide); saveLayout(L); drawDashboard(dash); $('#' + b.dataset.unhide)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); });
  $('#resetLayout').onclick = () => { try { localStorage.removeItem('layout:' + geo); } catch {} drawDashboard(dash); toast('Layout reset'); };
}
function refreshZoneButtons() {
  const zs = $$('#app > .zone');
  zs.forEach((z, i) => { $('[data-zact="up"]', z).disabled = i === 0; $('[data-zact="down"]', z).disabled = i === zs.length - 1; });
}
const drawTrendCards = () => {};

// ---------------- charts: palette checked with the dataviz validator (CVD + contrast pass) ----------------
const CAT = ['#2F6DB0', '#C97A1E', '#9361C2', '#6E9A2A'];

/** Score distribution (histogram) with the 85 bar marked. */
function scoreHistogram(list) {
  if (!list.length) return '';
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, n: 0 }));
  list.forEach(s => bins[Math.min(9, Math.floor(s.score / 10))].n++);
  const max = Math.max(1, ...bins.map(b => b.n)), W = innerWidth < 640 ? 340 : 600, H = 92, P = { l: 8, r: 8, t: 10, b: 20 }, bw = (W - P.l - P.r) / 10;
  const X = v => P.l + v / 100 * (W - P.l - P.r), Y = n => P.t + (1 - n / max) * (H - P.t - P.b);
  return `<div class="histo"><div class="histo-k"><b>Score distribution</b><span>${list.filter(s => s.score >= 85).length} at 85+ · ${list.length} total</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Signal scores: ${bins.filter(b => b.n).map(b => `${b.n} between ${b.lo} and ${b.lo + 9}`).join(', ')}">
    ${bins.map((b, i) => b.n ? `<rect class="hb ${b.lo >= 80 ? 'hi' : ''}" x="${P.l + i * bw + 1}" y="${Y(b.n)}" width="${bw - 2}" height="${H - P.b - Y(b.n)}" rx="4" style="--i:${i}"><title>${b.lo}–${b.lo + 9}: ${b.n} signal${b.n > 1 ? 's' : ''}</title></rect><text x="${P.l + i * bw + bw / 2}" y="${Y(b.n) - 3}" text-anchor="middle" class="hv">${b.n}</text>` : '').join('')}
    <line class="thr" x1="${X(85)}" x2="${X(85)}" y1="${P.t - 6}" y2="${H - P.b}"/><text class="thr-t" x="${X(85) + 4}" y="${P.t + 2}">85</text>
    ${[0, 20, 40, 60, 80, 100].map(v => `<text class="ax" x="${X(v)}" y="${H - 5}" text-anchor="middle">${v}</text>`).join('')}</svg></div>`;
}

/** Donut for parts of a whole (≤4 slices; the rest folds into "Other"). Legend + direct labels, never color alone. */
function donut(rows, { label = 'Total', fmt = money } = {}) {
  let r = [...rows].sort((a, b) => b.value - a.value);
  if (r.length > 4) r = [...r.slice(0, 3), { name: 'Other', value: r.slice(3).reduce((a, x) => a + x.value, 0) }];
  const tot = r.reduce((a, x) => a + x.value, 0);
  if (!tot) return '';
  const R = 52, C = 2 * Math.PI * R; let off = 0;
  const arcs = r.map((x, i) => { const len = x.value / tot * C; const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${CAT[i]}" stroke-width="20" stroke-dasharray="${Math.max(0, len - 2)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)" class="arc" style="--i:${i}"><title>${esc(x.name)}: ${fmt(x.value)} (${Math.round(x.value / tot * 100)}%)</title></circle>`; off += len; return seg; }).join('');
  return `<div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="${r.map(x => `${x.name} ${fmt(x.value)}`).join(', ')}">${arcs}<text x="70" y="66" text-anchor="middle" class="dv">${fmt(tot)}</text><text x="70" y="84" text-anchor="middle" class="dl">${esc(label)}</text></svg>
    <ul class="legend">${r.map((x, i) => `<li><i style="background:${CAT[i]}"></i>${esc(x.name)}<b>${fmt(x.value)}</b><span>${Math.round(x.value / tot * 100)}%</span></li>`).join('')}</ul></div>`;
}

// ---------------- refresh clock ----------------
let refreshTimer = null, scanning = false;
function startRefreshClock(d) {
  const el = $('#nextRefresh');
  if (!el || !d.nextRefresh) return;
  clearInterval(refreshTimer);
  const target = toDate(d.nextRefresh);
  const tick = () => {
    const ms = target - Date.now();
    if (ms <= 0) {
      el.textContent = 'Updating now…';
      if (ms < -5 * 60e3) { clearInterval(refreshTimer); dash = null; trendData = null; if (isHome()) renderDashboard(); }
      return;
    }
    const h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60e3), s = Math.floor(ms % 60e3 / 1000);
    el.innerHTML = `<span class="pre">Next update in </span>${h ? h + 'h ' : ''}${String(m).padStart(h ? 2 : 1, '0')}m <span class="sec">${String(s).padStart(2, '0')}s</span>`;
  };
  tick(); refreshTimer = setInterval(tick, 1000);
}
const isHome = () => !['sources', 'models'].includes(location.hash.replace(/^#\/?/, ''));
/** Ask the server to re-read sources (allowed for everyone once per 20 minutes), then redraw. */
async function backgroundScan() {
  if (scanning) return;
  scanning = true; setStatus('live', 'Refreshing sources…'); $('#refreshBtn')?.classList.add('spin');
  try {
    const res = await fetch('/api/run', { method: 'POST', credentials: 'same-origin' });
    if (res.ok && res.body) { const r = res.body.getReader(); while (!(await r.read()).done) {} }
  } catch { /* the cached data is still shown */ }
  scanning = false; $('#refreshBtn')?.classList.remove('spin');
  dash = null; trendData = null;
  if (isHome()) renderDashboard();
}
const hoursSince = d => d ? (Date.now() - toDate(d)) / 3600e3 : Infinity;
$('#refreshBtn')?.addEventListener('click', async () => {
  const run = dash?.lastRun;
  if (hoursSince(run?.finished_at) > 1) return backgroundScan();
  const b = $('#refreshBtn'); b.classList.add('spin');
  dash = null; trendData = null;
  if (isHome()) await renderDashboard(); else location.hash = '#/';
  b.classList.remove('spin'); toast('Showing the latest data');
});

const ICONS = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/>',
  hall: '<path d="M3 21h18M5 21V10M19 21V10M9 21V10M15 21V10M2 10l10-6 10 6z"/>',
  feed: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  book: '<path d="M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM8 7h8"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M15 9a3 3 0 0 0-3-1.5c-1.7 0-3 .9-3 2.2s1.3 1.8 3 2.1 3 .9 3 2.2-1.3 2.2-3 2.2A3 3 0 0 1 9 15M12 6v12"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
};
const ico = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

function countdown(d) {
  if (!d) return '';
  const days = Math.ceil((toDate(d) - Date.now()) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

const noIds = t => String(t || '').replace(/\s*\[(?:\d+\s*,?\s*)+\]/g, '');
const val = v => v != null && v !== '' && String(v).toLowerCase() !== 'null';
function storySummary(it, fallback) {
  const s = (it?.summary || '').trim();
  if (s.length < 40) return fallback;
  const cut = s.length > 230 ? s.slice(0, 230).replace(/\s+\S*$/, '') + '…' : s;
  return cut;
}
function storyCard(b, i, d) {
  const it = d.cites[b.items[0]];
  return `<article class="story" style="animation-delay:${i * 70}ms" data-i="${i}">
    <span class="num">${i + 1}</span>
    ${it ? `<h3>${esc(it.title.slice(0, 140))}</h3>` : ''}
    <p>${esc(storySummary(it, b.text))}</p>
    <div class="row"><span class="src">${b.items.map(id => d.cites[id]?.source).filter(Boolean).slice(0, 2).map(esc).join(' · ')}</span>
      ${it ? `<button class="read" data-story="${it.id}">Read story ↗</button>` : ''}</div>
  </article>`;
}

function signalCards(list) {
  const shown = list.filter(s => filter === 'All' || (s.tags || '').split(',').includes(filter));
  if (!shown.length) return `<p class="empty" style="padding:16px">${list.length ? 'No signals with this tag.' : `No signals for ${GEO_NAMES[geo]} yet.`}</p>`;
  return shown.map((s, i) => {
    const rule = s.rule_hit || (s.rule_hits || '').split(',')[0];
    return `<article class="card ${isFresh(s.found_at) ? 'fresh' : ''} ${s.status === 'pinned' ? 'pinned' : ''}" style="animation-delay:${Math.min(i, 12) * 40}ms" data-id="${s.id}">
      <h3><button data-story="${s.id}">${esc(s.title)}</button></h3>
      <div class="score" title="Relevance score"><b>${s.score}</b><span class="bar"><i data-w="${s.score}"></i></span></div>
      ${s.summary ? `<p class="sum">${esc(s.summary)}</p>` : ''}
      ${s.why ? `<p class="why"><b>Why it matters:</b> ${esc(s.why)}</p>` : ''}
      <div class="cmeta">
        <span class="src"><img src="${favicon(s.url)}" alt="" loading="lazy"> ${esc(s.source)}</span>
        <span>· ${s.published_at ? fmtDate(s.published_at) : 'found ' + ago(s.found_at)}</span>
        ${(s.tags || '').split(',').filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        ${rule ? `<span class="tag rule">${esc(rule)}</span>` : ''}
        <span class="card-actions"><button class="mini" data-act="${s.status === 'pinned' ? 'new' : 'pinned'}">${s.status === 'pinned' ? 'Unpin' : 'Pin'}</button><button class="mini" data-act="dismissed">Dismiss</button></span>
      </div>
    </article>`;
  }).join('');
}

function outlookPanel(d, span = 'span-12') {
  const o = d.outlook;
  const refs = ids => (ids || []).map(id => d.cites[id]).filter(Boolean).slice(0, 3).map(c => `<button class="linkbtn" data-story="${c.id}">${esc(c.title.replace(/^EDA /, '').slice(0, 46))}</button>`).join(' · ');
  if (!o) return `<section class="panel ${span}"><div class="panel-head"><h2>${ico('radar')}EDA Outlook</h2><span class="meta">last meeting · in motion · what's next</span></div><div class="panel-body"><p class="empty">Once EDAScout reads the EDA's agendas and minutes, this panel explains the last meeting, the initiatives in motion, and what is likely on upcoming agendas, each linked to its evidence.</p></div></section>`;
  const lm = o.last_meeting || {};
  return `<section class="panel ${span} outlook"><div class="panel-head"><h2>${ico('radar')}EDA Outlook</h2><span class="meta">from ${o.docs?.length || 0} EDA documents · updated ${ago(o.created)}</span></div>
    <div class="panel-body"><div class="ol-grid">
      <div class="ol-col"><h4>Last meeting${lm.date ? ` · ${fmtDate(lm.date)}` : ''}</h4><p>${esc(noIds(lm.summary))}</p>
        ${lm.decisions?.length ? `<ul class="ol-list">${lm.decisions.map(x => `<li><span class="ol-dot done"></span><div>${esc(noIds(x.text))}<div class="s">${refs(x.ids)}</div></div></li>`).join('')}</ul>` : ''}</div>
      <div class="ol-col"><h4>In motion</h4>${o.initiatives?.length ? `<ul class="ol-list">${o.initiatives.map(x => `<li><span class="ol-dot live"></span><div><b>${esc(x.name)}</b> ${esc(noIds(x.status))}<div class="s">${refs(x.ids)}</div></div></li>`).join('')}</ul>` : '<p class="muted">No ongoing initiatives found in recent documents.</p>'}</div>
      <div class="ol-col"><h4>Likely next <span class="tag rule">inferred</span></h4>${o.upcoming?.length ? `<ul class="ol-list">${o.upcoming.map(x => `<li><span class="ol-dot ${x.confidence}"></span><div><b>${esc(x.topic)}</b> <span class="tag ${x.confidence === 'likely' ? 'rule' : 'geo'}">${esc(x.confidence)}</span><div>${esc(noIds(x.why))}</div><div class="s">${refs(x.ids)}</div></div></li>`).join('')}</ul>` : '<p class="muted">No forward-looking items found yet.</p>'}
        <p class="muted" style="font-size:12px;margin-top:8px">Forecasts are inferred from tabled items, follow-ups and recurring reports in the documents. Check the official agenda before the meeting.</p></div>
    </div></div></section>`;
}

function moneyPanel(d) {
  const totals = (d.money.totals || []).slice(0, 4);
  const items = d.money.items || [];
  return `<section class="panel span-7"><div class="panel-head"><h2>${ico('coin')}Money tracker</h2><span class="meta">${GEO_NAMES[geo]} · last 90 days</span></div>
    ${totals.length ? `<div class="panel-body" style="padding-bottom:0">${donut((d.money.totals || []).map(t => ({ name: t.kind, value: t.total })), { label: '90-day total' })}</div>` : ''}
    <div class="panel-body flush scroll" style="max-height:460px">${items.length ? items.map(m => `<div class="money-row">
      <div><div class="amt">${money(m.amount)}</div><span class="tag k">${esc(m.kind)}</span></div>
      <div><p>${esc(m.label)}</p><div class="s"><button class="linkbtn" data-story="${m.id}">${esc(m.title.slice(0, 90))}</button> · ${esc(m.source)}</div></div>
    </div>`).join('') : '<p class="empty" style="padding:16px">Dollar figures (investments, grants, approvals, housing, budget) appear as sources mention them.</p>'}</div>
  </section>`;
}

function awardsPanel(d) {
  const a = d.awards || [];
  return `<section class="panel span-5"><div class="panel-head"><h2>${ico('flag')}Federal money in Norfolk</h2><span class="meta">USAspending · last 60 days</span></div>
    <div class="panel-body flush scroll" style="max-height:540px">${a.length ? `<ul class="rows">${a.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.recipient || 'Recipient')}</a> <span class="amtchip">${money(x.amount)}</span><span class="s">${esc(x.agency)}${x.start_date ? ' · ' + fmtDate(x.start_date) : ''}${x.description ? ' · ' + esc(x.description.slice(0, 110).toLowerCase()) : ''}</span></li>`).join('')}</ul>` : '<p class="empty" style="padding:16px">Federal contracts and grants performed in Norfolk load with the next scan.</p>'}</div>
  </section>`;
}

function topicsList(t) {
  if (!t?.list?.length) return '<p class="empty" style="padding:16px">Builds up as items arrive.</p>';
  const max = Math.max(1, ...t.list.flatMap(x => x.weeks));
  return `<ul class="topics">${t.list.map(x => `<li><span>${esc(x.tag)}</span><span class="bars" title="${x.weeks.join(', ')} items per week">${x.weeks.map((n, j) => `<i style="height:${Math.max(6, n / max * 100)}%;--j:${j}"></i>`).join('')}</span><span class="t">${x.total}</span></li>`).join('')}</ul>`;
}

// ---------------- trends ----------------
function trendsBlock() {
  const ms = trendData?.metrics || [];
  if (!ms.length) return `<section class="panel"><div class="panel-body"><p class="empty">Trend data for ${GEO_NAMES[geo]} loads with the next update (from the Federal Reserve's FRED database).</p></div></section>`;
  const groups = ['All', ...new Set(ms.map(m => m.group))];
  const shown = ms.filter(m => trendGroup === 'All' || m.group === trendGroup);
  return `<div class="trend-head"><div class="groups" role="toolbar" aria-label="Trend groups">${groups.map(g => `<button class="chip ${g === trendGroup ? 'on' : ''}" data-group="${g}">${g}</button>`).join('')}</div><span class="muted" style="font-size:12.5px">Tap any card for the full chart</span></div>
    <div class="metrics" id="metricCards">${shown.map(m => metricCard(m)).join('')}</div>`;
}

function metricCard(m) {
  const good = m.better === 'neutral' || m.change == null ? 'flat' : (m.change > 0) === (m.better === 'up') ? 'good' : 'bad';
  const arrow = m.change == null ? '' : m.change > 0 ? '▲' : m.change < 0 ? '▼' : '•';
  const chg = m.pct == null ? '' : m.unit === '%' ? `${arrow} ${Math.abs(m.change).toFixed(1)} pts` : `${arrow} ${Math.abs(m.pct).toFixed(1)}%`;
  return `<button class="metric" data-key="${m.key}" aria-haspopup="dialog" aria-label="${esc(m.label)}: open the full chart">
    <span class="k">${esc(m.label)}</span>
    <span class="v" data-val="${m.latest.v}" data-unit="${m.unit}">${fmtVal(m.latest.v, m.unit)}</span>
    <span class="d">${chg ? `<span class="chg ${good}">${chg}</span>` : ''}<span class="muted">${fmtDate(m.latest.d)}</span></span>
    ${spark(m.points)}
    <span class="open-hint">Full chart ↗</span>
  </button>`;
}

function spark(pts) {
  if (!pts || pts.length < 2) return '';
  const W = 200, H = 46, vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), r = hi - lo || 1;
  const xy = pts.map((p, i) => [i / (pts.length - 1) * W, H - 4 - (p.v - lo) / r * (H - 10)]);
  const d = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = xy[xy.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#225081" stop-opacity=".18"/><stop offset="1" stop-color="#225081" stop-opacity="0"/></linearGradient></defs>
    <path class="area" d="${d}L${W},${H}L0,${H}Z"/><path class="line draw" d="${d}" vector-effect="non-scaling-stroke" pathLength="1" style="--len:1"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || mag * 10;
  const a = Math.floor(lo / step) * step, out = [];
  for (let v = a; v <= hi + step * .5; v += step) out.push(+v.toFixed(10));
  return out;
}

// Chart type follows the data: counts → bars, prices and totals → area, rates and indexes → line.
const CHART_FOR = { unemp: 'line', jobs: 'bar', list_price: 'area', listings: 'bar', dom: 'line', permits: 'bar', hpi: 'line', income: 'area', gdp: 'area' };
const RANGES = [['7D', 7], ['30D', 30], ['90D', 90], ['YTD', 'ytd'], ['1Y', 365], ['5Y', 1830]];
function cadenceOf(pts) {
  if (pts.length < 3) return 'occasionally';
  const gaps = pts.slice(1).map((p, i) => (toDate(p.d) - toDate(pts[i].d)) / 864e5).sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length / 2)];
  return g < 10 ? 'weekly' : g < 40 ? 'monthly' : g < 120 ? 'quarterly' : 'yearly';
}
function inRange(pts, r) {
  const now = Date.now();
  const from = r === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) : now - r * 864e5;
  return pts.filter(p => toDate(p.d) >= from);
}

function openMetric(key, range = '1Y', type = null) {
  const m = trendData?.metrics?.find(x => x.key === key);
  if (!m) return;
  type ||= CHART_FOR[m.key] || 'line';
  const cad = cadenceOf(m.points);
  const close = openModal(`<header><div><h2 id="modalTitle">${esc(m.label)} · ${GEO_NAMES[geo]}</h2><div class="sub">Published ${cad} · latest ${fmtDate(m.latest.d)} · <a href="${esc(m.source)}" target="_blank" rel="noopener">FRED ${esc(m.series)} ↗</a></div></div><button class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="body chart-modal">
      <div class="cm-bar"><div class="seg" role="toolbar" aria-label="Time range">${RANGES.map(([l, v]) => `<button data-range="${l}" class="${l === range ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" role="toolbar" aria-label="Chart type">${['line', 'area', 'bar'].map(t => `<button data-type="${t}" class="${t === type ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      <div class="cm-stats" id="cmStats"></div>
      <p class="note" id="cmNote" hidden></p>
      <div class="chart-wrap" id="cmChart"></div>
      <details class="tbl"><summary>Show as a table</summary><div id="cmTable"></div></details>
    </div>
    <footer><button class="btn" data-listen>▶ Listen</button><span class="muted" style="font-size:12px">Federal Reserve Bank of St. Louis (FRED) data.</span><button class="btn primary" data-close data-autofocus>Done</button></footer>`);
  const draw = () => {
    const rv = RANGES.find(r => r[0] === range)[1];
    let pts = inRange(m.points, rv), note = '';
    if (pts.length < 2) {
      pts = m.points.slice(-2);
      note = `No new ${m.label.toLowerCase()} readings in the last ${range === 'YTD' ? 'part of this year' : range.replace('D', ' days')}. This series is published ${cad} (latest: ${fmtDate(m.latest.d)}), so the two most recent readings are shown.`;
    }
    const first = pts[0], last = pts[pts.length - 1], vs = pts.map(p => p.v);
    const diff = last.v - first.v, pct = first.v ? diff / Math.abs(first.v) * 100 : 0;
    const chg = m.unit === '%' ? `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pts` : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    $('#cmStats').innerHTML = [['Latest', fmtVal(last.v, m.unit)], [`Change (${fmtDate(first.d)} → ${fmtDate(last.d)})`, chg], ['High', fmtVal(Math.max(...vs), m.unit)], ['Low', fmtVal(Math.min(...vs), m.unit)]]
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('#cmNote').hidden = !note; $('#cmNote').textContent = note;
    drawChart($('#cmChart'), m, pts, pts.length <= 3 ? 'bar' : type);
    $('#cmTable').innerHTML = `<table class="trend-table"><thead><tr><th>Date</th><th>${esc(m.label)}</th></tr></thead><tbody>${[...pts].reverse().map(p => `<tr><td>${fmtDate(p.d)}</td><td class="n">${fmtVal(p.v, m.unit)}</td></tr>`).join('')}</tbody></table>`;
  };
  $$('#modal [data-range]').forEach(b => b.onclick = () => { range = b.dataset.range; $$('#modal [data-range]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  $$('#modal [data-type]').forEach(b => b.onclick = () => { type = b.dataset.type; $$('#modal [data-type]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  $('#modal [data-listen]').onclick = () => { speechSynthesis?.cancel(); speakText(`${m.label} in ${GEO_NAMES[geo]} is ${fmtVal(m.latest.v, m.unit)} as of ${fmtDate(m.latest.d)}${chgWords(m) ? ', ' + chgWords(m) : ''}.`); };
  requestAnimationFrame(draw);
  return close;
}

/** One chart renderer for line, area and bar; hover tooltip on every type. */
function drawChart(wrap, m, pts, type) {
  wrap.classList.remove('drawn');
  const W = Math.max(300, wrap.clientWidth), H = 280, P = { l: 64, r: 16, t: 16, b: 30 };
  const vs = pts.map(p => p.v);
  const ticks = niceTicks(type === 'bar' ? Math.min(0, ...vs) : Math.min(...vs), Math.max(...vs));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const n = pts.length, bw = (W - P.l - P.r) / n;
  const t0 = toDate(pts[0].d) - 0, t1 = toDate(pts[n - 1].d) - 0;
  const X = type === 'bar' ? (p, i) => P.l + bw * i + bw / 2 : p => P.l + ((toDate(p.d) - t0) / ((t1 - t0) || 1)) * (W - P.l - P.r);
  const Y = v => P.t + (1 - (v - lo) / ((hi - lo) || 1)) * (H - P.t - P.b);
  const xs = pts.map((p, i) => X(p, i));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const spanDays = (t1 - t0) / 864e5;
  const lab = d => spanDays > 800 ? d.slice(0, 4) : toDate(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 80))));
  const marks = type === 'bar'
    ? pts.map((p, i) => { const y = Y(p.v), y0 = Y(Math.max(lo, 0)), w = Math.max(2, Math.min(42, bw - 2)); return `<rect class="bar" x="${(xs[i] - w / 2).toFixed(1)}" y="${Math.min(y, y0).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, Math.abs(y0 - y)).toFixed(1)}" rx="${Math.min(4, w / 2)}" style="--i:${i}"/>`; }).join('')
    : `${type === 'area' ? `<path class="area" d="${line}L${xs[n - 1]},${H - P.b}L${xs[0]},${H - P.b}Z"/>` : ''}<path class="line draw" d="${line}" pathLength="1"/>`;
  wrap.innerHTML = `<svg class="chart ${type}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)}, ${fmtVal(pts[n - 1].v, m.unit)} as of ${fmtDate(pts[n - 1].d)}">
    <defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#225081" stop-opacity=".22"/><stop offset="1" stop-color="#225081" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}"/>`).join('')}</g>
    <g class="axis">${ticks.map(t => `<text x="${P.l - 8}" y="${Y(t) + 4}" text-anchor="end">${fmtVal(t, m.unit)}</text>`).join('')}
      ${(() => { let prev = ''; return pts.map((p, i) => { const t = lab(p.d); if ((i % every && i !== n - 1) || t === prev) return ''; prev = t; return `<text x="${xs[i]}" y="${H - 8}" text-anchor="middle">${t}</text>`; }).join(''); })()}</g>
    ${marks}
    <line class="cross" y1="${P.t}" y2="${H - P.b}" opacity="0"/>
    <circle class="hot" r="5" cx="${xs[n - 1]}" cy="${Y(pts[n - 1].v)}" ${type === 'bar' ? 'opacity="0"' : ''}/>
    <rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" class="hit"/>
  </svg><div class="tip" style="opacity:0"></div>`;
  requestAnimationFrame(() => wrap.classList.add('drawn'));
  const svg = $('svg', wrap), tip = $('.tip', wrap), cross = $('.cross', svg), hot = $('.hot', svg);
  $('.hit', svg).addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * (W / r.width);
    let bi = 0; xs.forEach((v, i) => { if (Math.abs(v - x) < Math.abs(xs[bi] - x)) bi = i; });
    const p = pts[bi], cx = xs[bi], cy = Y(p.v);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', 1);
    if (type !== 'bar') { hot.setAttribute('cx', cx); hot.setAttribute('cy', cy); }
    $$('.bar', svg).forEach((b, i) => b.classList.toggle('on', i === bi));
    tip.style.opacity = 1; tip.style.left = `${cx / W * 100}%`; tip.style.top = `${cy / H * 100}%`;
    tip.innerHTML = `${fmtDate(p.d)} · <b>${fmtVal(p.v, m.unit)}</b>`;
  });
  $('.hit', svg).addEventListener('pointerleave', () => { tip.style.opacity = 0; cross.setAttribute('opacity', 0); $$('.bar', svg).forEach(b => b.classList.remove('on')); });
}

function wireTrends() {
  $$('[data-group]').forEach(b => b.onclick = () => {
    trendGroup = b.dataset.group;
    swap(() => { $('#trends .zone-body').innerHTML = trendsBlock(); wireTrends(); });
  });
  $$('.metric').forEach(b => b.onclick = () => openMetric(b.dataset.key));
}

function wireDashboard(d, B) {
  $$('.filters .chip').forEach(c => c.onclick = () => {
    filter = c.dataset.tag;
    $$('.filters .chip').forEach(x => x.classList.toggle('on', x === c));
    swap(() => { $('#signalCards').innerHTML = signalCards(d.signals); bars(); wireCards(d); wireStories(); });
  });
  bars(); wireCards(d); wireStories(); wireTrends();
  $$('[data-jump]').forEach(b => b.onclick = () => $('#' + b.dataset.jump)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }));
  const L = $('#listen');
  if (L) L.onclick = () => speakParts(briefSpeech(B), L);
  const groups = meetingGroups(d);
  $$('[data-speak]').forEach(btn => btn.onclick = () => {
    const k = btn.dataset.speak;
    const text = k === 'outlook' ? outlookSpeech(d.outlook) : meetingSpeech(groups[+k.slice(3)]);
    speakParts([{ say: null, text }], btn);
  });
}
const bars = () => requestAnimationFrame(() => $$('.score [data-w]').forEach(el => (el.style.width = el.dataset.w + '%')));
const wireStories = () => $$('[data-story]', app).forEach(b => b.onclick = e => { e.preventDefault(); openStory(+b.dataset.story); });

function wireCards(d) {
  $$('.card [data-act]').forEach(b => b.onclick = async () => {
    const card = b.closest('.card'), id = +card.dataset.id, status = b.dataset.act;
    try {
      await edit(() => api(`/api/signals/${id}`, { method: 'POST', body: { status } }));
      const s = d.signals.find(x => x.id === id);
      if (status === 'dismissed') {
        d.signals = d.signals.filter(x => x.id !== id);
        card.style.transition = 'opacity .25s, transform .25s'; card.style.opacity = 0; card.style.transform = 'translateX(16px)';
        setTimeout(() => { $('#signalCards').innerHTML = signalCards(d.signals); bars(); wireCards(d); wireStories(); }, 250);
        toast('Signal dismissed', { label: 'Undo', run: async () => { await api(`/api/signals/${id}`, { method: 'POST', body: { status: 'new' } }); dash = null; renderDashboard(); } });
      } else { s.status = status; $('#signalCards').innerHTML = signalCards(d.signals); bars(); wireCards(d); wireStories(); }
    } catch (e) { if (e.message !== 'Edit cancelled') toast(e.message); }
  });
}

// ---------------- story modal ----------------
let lastFocus = null;
function openModal(html) {
  lastFocus = document.activeElement;
  const m = $('#modal'), back = $('#modalBack');
  m.innerHTML = html; m.hidden = false; back.hidden = false;
  document.body.style.overflow = 'hidden';
  const close = () => { m.hidden = true; back.hidden = true; document.body.style.overflow = ''; lastFocus?.focus?.(); removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  back.onclick = close;
  $$('[data-close]', m).forEach(b => b.onclick = close);
  ($('[data-autofocus]', m) || $('[data-close]', m))?.focus();
  return close;
}

async function openStory(id) {
  openModal(`<header><div><h2 id="modalTitle">Loading story…</h2></div><button class="icon-btn" data-close aria-label="Close">×</button></header><div class="body"><div class="sk"></div><div class="sk"></div><div class="sk" style="width:60%"></div></div>`);
  let s;
  try { s = await api(`/api/item/${id}`); } catch (e) { $('#modal .body').innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const acts = s.meeting?.actions?.actions?.filter(x => x.item) || [];
  const close = openModal(`<header><div><h2 id="modalTitle">${esc(s.title)}</h2><div class="sub">${esc(s.source)} · ${s.published ? fmtDate(s.published) : 'found ' + ago(s.found)}${s.tags ? ' · ' + esc(s.tags.replace(/,/g, ', ')) : ''}</div></div><button class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="body">
      ${s.summary ? `<p class="lede">${esc(s.summary)}</p>` : ''}
      ${s.why ? `<div class="whybox"><b>Why it matters:</b> ${esc(s.why)}</div>` : ''}
      ${acts.length ? `<div><h4>Actions in this document</h4><ul>${acts.map(x => `<li>${esc(x.item)}${val(x.outcome) ? ` · <i>${esc(x.outcome)}</i>` : ''}${val(x.amount_usd) ? ` <span class="amtchip">${esc(x.amount_usd)}</span>` : ''}${val(x.vote) ? ` <span class="amtchip">vote ${esc(x.vote)}</span>` : ''}${val(x.parties) ? ` · ${esc(x.parties)}` : ''}</li>`).join('')}</ul></div>` : ''}
      ${s.money?.length ? `<div><h4>Money mentioned</h4>${s.money.map(m => `<div class="money-row" style="padding:8px 0"><div><div class="amt">${money(m.amount)}</div><span class="tag k">${esc(m.kind)}</span></div><div><p>${esc(m.label)}</p></div></div>`).join('')}</div>` : ''}
      ${s.excerpt ? `<div><h4>${s.excerptKind === 'news' ? 'Opening of the article' : 'From the source document'}</h4><div class="excerpt">${esc(s.excerpt)}</div></div>` : ''}
      ${s.related?.length ? `<div><h4>Related</h4><ul class="rows" style="border:1px solid var(--line);border-radius:8px">${s.related.map(r => `<li><button class="linkbtn" data-related="${r.id}">${esc(r.title)}</button><span class="s">${esc(r.source)} · ${ago(r.found_at)}</span></li>`).join('')}</ul></div>` : ''}
    </div>
    <footer><button class="btn" data-listen>▶ Listen</button><span class="muted" style="font-size:12px">Summary is machine-written; the original is the record.</span><a class="btn primary" href="${esc(s.url)}" target="_blank" rel="noopener" data-autofocus>Open full story ↗</a></footer>`);
  $$('#modal [data-related]').forEach(b => b.onclick = () => { close(); openStory(+b.dataset.related); });
  $('#modal [data-listen]').onclick = () => { speechSynthesis?.cancel(); speakText(`${s.title}. ${s.summary || ''} ${s.why ? 'Why it matters: ' + s.why : ''}`); };
}

// ---------------- edit key prompt ----------------
function askKey() {
  return new Promise(resolve => {
    let done = false;
    const close = openModal(`<header><div><h2 id="modalTitle">Edit key</h2><div class="sub">Viewing is open to everyone. Changing sources or settings needs the owner's edit key.</div></div><button class="icon-btn" data-close aria-label="Close">×</button></header>
      <form class="body" id="keyForm"><div><label for="ek">Edit key</label><input id="ek" type="password" autocomplete="current-password" required data-autofocus></div><p class="muted" id="kerr" role="alert" style="margin:0"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Unlock editing</button></div></form>`);
    const obs = new MutationObserver(() => { if ($('#modal').hidden && !done) { done = true; obs.disconnect(); resolve(false); } });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    $('#keyForm').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/login', { method: 'POST', body: { key: $('#ek').value.trim() } }); done = true; obs.disconnect(); close(); toast('Editing unlocked on this device'); resolve(true); }
      catch (err) { $('#kerr').textContent = err.message; }
    };
  });
}

// ---------------- Listen ----------------
function speakText(text, { onstart, onend } = {}) {
  if (!('speechSynthesis' in window)) { toast('Your browser cannot read aloud.'); return; }
  const u = new SpeechSynthesisUtterance(text.replace(/\bEDA\b/g, 'E.D.A.').replace(/\bNRHA\b/g, 'N.R.H.A.'));
  u.rate = 1.02; u.lang = 'en-US';
  const v = speechSynthesis.getVoices().find(v => /en-US/.test(v.lang) && /natural|neural|samantha|google us/i.test(v.name));
  if (v) u.voice = v;
  u.onstart = onstart; u.onend = onend; u.onerror = onend;
  speechSynthesis.speak(u);
}
/** Read a list of parts aloud; the button toggles to Stop; the part being read is highlighted. */
function speakParts(parts, btn) {
  const label = btn.querySelector('.lt') || btn, orig = btn.dataset.orig || label.textContent;
  btn.dataset.orig = orig;
  const clear = () => { btn.classList.remove('speaking-now'); label.textContent = orig; $$('[data-say].speaking').forEach(l => l.classList.remove('speaking')); };
  if (speechSynthesis.speaking) { const same = btn.classList.contains('speaking-now'); speechSynthesis.cancel(); $$('.speaking-now').forEach(x => { x.classList.remove('speaking-now'); const l = x.querySelector('.lt') || x; l.textContent = x.dataset.orig || l.textContent; }); clear(); if (same) return; }
  btn.classList.add('speaking-now'); label.textContent = btn.querySelector('.lt') ? 'Stop' : '■ Stop';
  parts.forEach((p, i) => speakText(p.text, {
    onstart: () => { $$('[data-say].speaking').forEach(l => l.classList.remove('speaking')); if (p.say) $(`[data-say="${p.say}"]`)?.classList.add('speaking'); },
    onend: () => { if (i === parts.length - 1) clear(); },
  }));
}

// ---------------- Ask ----------------
const drawer = $('#askDrawer'), fab = $('#askFab');
fab.onclick = () => { drawer.hidden = false; fab.hidden = true; $('#askInput').focus(); };
$('#askClose').onclick = () => { drawer.hidden = true; fab.hidden = false; speechSynthesis?.cancel(); };
$('#askForm').onsubmit = e => { e.preventDefault(); ask($('#askInput').value); };
async function ask(q, spoken = false) {
  q = q.trim();
  if (!q) return;
  const log = $('#askLog');
  log.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div>`);
  $('#askInput').value = '';
  const pending = document.createElement('div');
  pending.className = 'msg bot'; pending.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  log.append(pending); log.scrollTop = log.scrollHeight;
  try {
    const r = await api('/api/ask', { method: 'POST', body: { q } });
    pending.innerHTML = `${esc(r.answer)}${r.sources.length ? `<div class="srcs">${r.sources.map(s => s.id ? `<button class="linkbtn" data-story="${s.id}" style="text-align:left">${esc(s.source)}: ${esc(s.title.slice(0, 80))}</button>` : `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a>`).join('')}</div>` : ''}`;
    $$('[data-story]', pending).forEach(b => b.onclick = () => openStory(+b.dataset.story));
    if (spoken) { const orb = $('#askMic'); speakText(r.answer, { onstart: () => orb.classList.add('speaking'), onend: () => orb.classList.remove('speaking') }); }
  } catch (e) { pending.textContent = e.message; }
  log.scrollTop = log.scrollHeight;
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$('#askMic').onclick = () => {
  if (!SR) { toast('Voice input works in Chrome, Edge and Safari. You can type instead.'); return; }
  const rec = new SR(), orb = $('#askMic');
  rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onstart = () => orb.classList.add('listening');
  rec.onend = () => orb.classList.remove('listening');
  rec.onerror = () => orb.classList.remove('listening');
  rec.onresult = e => ask(e.results[0][0].transcript, true);
  speechSynthesis?.cancel(); rec.start();
};

// ---------------- Sources ----------------
let sources = [], tierTab = 'all';
async function renderSources() {
  setStatus('idle', 'Sources');
  const me = await api('/api/me').catch(() => ({ editor: false }));
  app.innerHTML = `<div class="page-head"><div><h1>Sources</h1><p>Everything EDAScout reads. Anyone can run a fresh scan; adding, pausing or removing sources asks for the edit key.</p></div>
    <div class="actions"><button class="btn" id="runNow">Run scan now</button><button class="btn primary" id="addBtn">+ Add source</button>${me.editor ? '<button class="btn" id="logout">Lock editing</button>' : ''}</div></div>
    <div id="runLog"></div>
    <div class="tabs" role="toolbar">${[['all', 'All'], ['norfolk', 'Norfolk'], ['region', 'Hampton Roads'], ['state', 'Virginia'], ['national', 'National'], ['paused', 'Paused'], ['removed', 'Removed']].map(([k, l]) => `<button class="chip ${k === tierTab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}<input id="q" placeholder="Search sources" aria-label="Search sources"></div>
    <section class="panel"><div class="panel-body flush" style="overflow:auto"><table class="src-table"><thead><tr><th>Health</th><th>Source</th><th>Area</th><th>Type</th><th>Cadence</th><th>Last new</th><th>Active</th><th></th></tr></thead><tbody id="srcRows"><tr><td colspan="8"><div class="sk"></div><div class="sk"></div></td></tr></tbody></table></div></section>`;
  $('#addBtn').onclick = () => openDrawer();
  $('#runNow').onclick = runNow;
  $('#q').oninput = drawRows;
  if ($('#logout')) $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); toast('Editing locked'); renderSources(); };
  $$('[data-tab]').forEach(b => b.onclick = () => { tierTab = b.dataset.tab; $$('[data-tab]').forEach(x => x.classList.toggle('on', x === b)); drawRows(); });
  sources = await api('/api/sources');
  drawRows();
}

function health(s) {
  if (s.kind === 'reference') return ['g', 'Linked reference (not fetched)'];
  if (s.deleted_at || !s.active) return ['n', 'Paused'];
  if (!s.last_fetched) return ['n', 'Not scanned yet'];
  if (s.fail_count >= 3) return ['r', s.last_error || 'Failing'];
  if (s.fail_count > 0) return ['a', s.last_error || 'Last fetch failed'];
  return ['g', 'Healthy'];
}

function drawRows() {
  const q = ($('#q')?.value || '').toLowerCase();
  const list = sources.filter(s => {
    if (tierTab === 'removed') return !!s.deleted_at;
    if (s.deleted_at) return false;
    if (tierTab === 'paused') return !s.active;
    if (tierTab !== 'all' && s.geo !== tierTab) return false;
    return true;
  }).filter(s => !q || `${s.name} ${s.url} ${s.tags}`.toLowerCase().includes(q));
  $('#srcRows').innerHTML = list.length ? list.map(s => {
    const [h, ht] = health(s);
    return `<tr data-id="${s.id}" class="${s.deleted_at ? 'deleted' : ''}">
      <td><span class="health ${h}" title="${esc(ht)}"></span><span class="muted" style="font-size:12px">${esc(h === 'g' ? (s.kind === 'reference' ? 'Link' : 'OK') : h === 'n' ? '—' : 'Check')}</span></td>
      <td><b>${esc(s.name)}</b> ${s.origin === 'recommended' ? '<span class="tag rule">recommended</span>' : s.origin === 'added' ? '<span class="tag">added</span>' : ''}<a class="u" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>${s.fail_count && s.kind !== 'reference' ? `<span class="u" style="color:var(--nfk-alert)">${esc(s.last_error || '')}</span>` : ''}</td>
      <td>${esc({ norfolk: 'Norfolk', region: 'Hampton Roads', state: 'Virginia', national: 'National' }[s.geo] || s.geo)}</td><td>${esc(s.kind)}</td><td>${esc(s.cadence)}</td>
      <td class="muted">${s.last_new ? ago(s.last_new) : '—'}<br><span style="font-size:12px">${s.item_count} items</span></td>
      <td>${s.deleted_at ? '' : `<button class="toggle" data-act="toggle" aria-pressed="${!!s.active}" aria-label="Active"></button>`}</td>
      <td><div class="row-actions">${s.deleted_at ? '<button class="mini" data-act="restore">Restore</button>' : '<button class="mini" data-act="test">Test now</button><button class="mini" data-act="edit">Edit</button><button class="mini" data-act="remove">Remove</button>'}</div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">No sources here.</td></tr>';
  $$('#srcRows [data-act]').forEach(b => b.onclick = () => rowAction(b));
}

async function rowAction(b) {
  const tr = b.closest('tr'), id = +tr.dataset.id, s = sources.find(x => x.id === id), act = b.dataset.act;
  try {
    if (act === 'toggle') {
      const on = b.getAttribute('aria-pressed') !== 'true';
      await edit(() => api(`/api/sources/${id}`, { method: 'PATCH', body: { active: on } }));
      s.active = on ? 1 : 0; b.setAttribute('aria-pressed', on); toast(on ? `${s.name} resumed` : `${s.name} paused`);
    } else if (act === 'remove') {
      await edit(() => api(`/api/sources/${id}`, { method: 'DELETE' }));
      tr.classList.add('removing');
      s.deleted_at = new Date().toISOString(); s.active = 0;
      setTimeout(drawRows, 250);
      toast(`Removed ${s.name}`, { label: 'Undo', run: async () => { await api(`/api/sources/${id}/restore`, { method: 'POST' }); s.deleted_at = null; s.active = 1; drawRows(); } });
    } else if (act === 'restore') {
      await edit(() => api(`/api/sources/${id}/restore`, { method: 'POST' })); s.deleted_at = null; s.active = 1; drawRows(); toast(`Restored ${s.name}`);
    } else if (act === 'test') {
      b.disabled = true; b.textContent = 'Testing…';
      try { const r = await edit(() => api(`/api/sources/${id}/test`, { method: 'POST' })); openDrawer(s, r); }
      finally { b.disabled = false; b.textContent = 'Test now'; }
    } else if (act === 'edit') { await edit(() => api('/api/models')); openDrawer(s); }
  } catch (e) { if (e.message !== 'Edit cancelled') toast(e.message); }
}

function openDrawer(src = null, testResult = null) {
  const isEdit = !!src;
  const back = document.createElement('div'); back.className = 'drawer-back';
  const el = document.createElement('aside'); el.className = 'drawer'; el.setAttribute('aria-label', isEdit ? 'Edit source' : 'Add source');
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
  el.innerHTML = `<header><h2>${isEdit ? 'Edit source' : 'Add a source'}</h2><button class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="body">
      ${isEdit ? `<div><label>Web address</label><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.url)}</a></div>`
        : `<div><label for="f-url">Web address (page, RSS feed or PDF)</label><div style="display:flex;gap:8px"><input id="f-url" type="url" placeholder="https://…" required><button class="btn" id="f-prev" type="button">Preview</button></div></div>`}
      <div id="f-preview">${testResult ? previewHtml(testResult) : ''}</div>
      <div><label for="f-name">Name</label><input id="f-name" value="${esc(src?.name || '')}" placeholder="e.g. Hampton Roads Alliance news"></div>
      <div class="two">
        <div><label for="f-geo">Area</label><select id="f-geo">${opt([['norfolk', 'Norfolk'], ['region', 'Hampton Roads'], ['state', 'Virginia'], ['national', 'National']], src?.geo || 'norfolk')}</select></div>
        <div><label for="f-cad">How often</label><select id="f-cad">${opt([['daily', 'daily'], ['weekly', 'weekly'], ['monthly', 'monthly']], src?.cadence || 'daily')}</select></div>
      </div>
      <div class="two">
        <div><label for="f-kind">What it is</label><select id="f-kind">${opt([['news', 'News / announcements'], ['meetings', 'Meeting agendas & minutes'], ['cityhall', 'City Hall meetings list'], ['properties', 'Properties / listings'], ['grants', 'Grants / funding'], ['context', 'Plan or report (context)'], ['reference', 'Link only (never fetched)']], src?.kind || 'news')}</select></div>
        <div><label for="f-tier">Priority</label><select id="f-tier">${opt([[1, 'High'], [2, 'Normal'], [3, 'Background']], src?.tier || 1)}</select></div>
      </div>
      <div><label for="f-tags">Tags</label><input id="f-tags" value="${esc(src?.tags || '')}" placeholder="Maritime, Downtown"></div>
      <div><label for="f-kw">Only keep items mentioning (optional)</label><input id="f-kw" value="${esc(src?.keyword_filter || '')}" placeholder="Norfolk, Hampton Roads"></div>
    </div>
    <footer><button class="btn" data-close>Cancel</button><button class="btn primary" id="f-save">${isEdit ? 'Save changes' : 'Add source'}</button></footer>`;
  document.body.append(back, el);
  const close = () => { back.remove(); el.remove(); };
  back.onclick = close; $$('[data-close]', el).forEach(b => b.onclick = close);
  (isEdit ? $('#f-name', el) : $('#f-url', el)).focus();
  if (!isEdit) $('#f-prev', el).onclick = async () => {
    const box = $('#f-preview', el), btn = $('#f-prev', el);
    btn.disabled = true; btn.textContent = 'Reading…';
    box.innerHTML = '<div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    try {
      const r = await edit(() => api('/api/sources/preview', { method: 'POST', body: { url: $('#f-url', el).value, kind: $('#f-kind', el).value, keyword_filter: $('#f-kw', el).value } }));
      box.innerHTML = previewHtml(r);
      if (!$('#f-name', el).value) $('#f-name', el).value = new URL(r.url).hostname.replace(/^www\./, '');
    } catch (e) { box.innerHTML = `<p style="color:var(--nfk-alert)">${esc(e.message)}</p>`; }
    btn.disabled = false; btn.textContent = 'Preview';
  };
  $('#f-save', el).onclick = async () => {
    const body = { name: $('#f-name', el).value, tier: +$('#f-tier', el).value, geo: $('#f-geo', el).value, cadence: $('#f-cad', el).value, kind: $('#f-kind', el).value, tags: $('#f-tags', el).value, keyword_filter: $('#f-kw', el).value };
    try {
      if (isEdit) await edit(() => api(`/api/sources/${src.id}`, { method: 'PATCH', body }));
      else await edit(() => api('/api/sources', { method: 'POST', body: { ...body, url: $('#f-url', el).value } }));
      close(); toast(isEdit ? 'Saved' : 'Source added. It will be read on the next scan.');
      sources = await api('/api/sources'); drawRows();
    } catch (e) { if (e.message !== 'Edit cancelled') toast(e.message); }
  };
}

function previewHtml(r) {
  if (r.ok === false) return `<p style="color:var(--nfk-alert)">Couldn't read it: ${esc(r.error)}</p>`;
  const c = r.candidates || [];
  return `<div class="preview"><div class="panel-head" style="background:transparent"><h2 style="font-size:13px">What EDAScout sees (${esc(r.method)})</h2></div>
    ${c.length ? `<ul class="rows">${c.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.published ? `<span class="s">${fmtDate(x.published)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="empty" style="padding:12px">No item links found. Try "Plan or report" as the type, or a more specific page.</p>'}</div>`;
}

async function runNow() {
  const btn = $('#runNow'), log = $('#runLog');
  btn.disabled = true; btn.textContent = 'Scanning…';
  setStatus('live', 'Scanning sources…');
  log.innerHTML = '<div class="log" id="rl" aria-live="polite">Starting scan…<br></div>';
  const rl = $('#rl');
  const line = h => { rl.insertAdjacentHTML('beforeend', h + '<br>'); rl.scrollTop = rl.scrollHeight; };
  try {
    const res = await fetch('/api/run', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (ev.type === 'start') line(`Reading ${ev.sources} sources…`);
        if (ev.type === 'source') line(ev.ok ? `<span class="ok">✓</span> ${esc(ev.name)}${ev.newItems ? ` · ${ev.newItems} new` : ''}` : `<span class="bad">✗</span> ${esc(ev.name)} · ${esc(ev.error)}`);
        if (ev.type === 'data') line(ev.error ? `<span class="bad">✗</span> ${esc(ev.name)} · ${esc(ev.error)}` : `<span class="ok">✓</span> ${esc(ev.name)}${ev.skipped ? ' · up to date' : ev.ok != null ? ` · ${ev.ok} loaded` : ''}${ev.failed?.length ? ` · ${ev.failed.length} unavailable` : ''}`);
        if (ev.type === 'phase') line({ trends: 'Updating trend and federal data…', summarizing: 'Summarizing new items…', brief: "Writing today's brief…" }[ev.phase] || ev.phase);
        if (ev.type === 'done') { line(`<span class="ok">Done.</span> ${ev.newItems} new items, ${ev.sourcesOk} sources OK, ${ev.sourcesFailed} failed, ${ev.llmCalls} AI calls.`); setStatus('', 'Updated just now'); }
        if (ev.type === 'error') line(`<span class="bad">Error:</span> ${esc(ev.error)}`);
      }
    }
  } catch (e) { line(`<span class="bad">${esc(e.message)}</span>`); setStatus('idle', 'Sources'); }
  btn.disabled = false; btn.textContent = 'Run scan now';
  dash = null; trendData = null;
  sources = await api('/api/sources'); drawRows();
}

// ---------------- Models ----------------
async function renderModels() {
  setStatus('idle', 'Models');
  app.innerHTML = '<div class="sk"></div>';
  let d;
  try { d = await edit(() => api('/api/models')); }
  catch (e) { app.innerHTML = `<div class="page-head"><div><h1>Models</h1><p>${e.message === 'Edit cancelled' ? 'The Models page needs the edit key.' : esc(e.message)}</p></div></div>`; return; }
  const label = { summarize: 'Summarize items', extract: 'Read meeting PDFs', synthesize: 'Write the brief', voice: 'Answer questions (Ask)' };
  app.innerHTML = `<div class="page-head"><div><h1>Models</h1><p>No job is tied to one AI company. Each job tries the cheapest model first and moves to the next only if the answer fails a check. Workers AI needs no key.</p></div></div>
    <p class="muted" style="margin:-6px 0 16px">Keys connected: ${d.keysConnected.length ? d.keysConnected.map(k => `<span class="tag">${esc(k)}</span>`).join(' ') : '<b>none</b>, so everything runs on Cloudflare Workers AI (included in your plan)'}. Add GEMINI_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY as Worker secrets to unlock those options.</p>
    <div class="grid">${d.routes.map(r => {
      const use = d.usage.filter(u => u.task === r.task);
      return `<section class="panel span-6" data-task="${esc(r.task)}"><div class="panel-head"><h2>${esc(label[r.task] || r.task)}</h2><span class="meta">${use.reduce((a, u) => a + u.calls, 0)} calls · 30 days</span></div>
      <div class="panel-body" style="display:grid;gap:10px">
        <label>Model chain, cheapest first (one per line: <code>workers-ai @cf/…</code> or <code>https://base-url model-name KEY_NAME</code>)</label>
        <textarea rows="4" style="font-family:var(--mono);font-size:12.5px">${esc(r.chain.map(s => s.provider === 'workers-ai' ? `workers-ai ${s.model}` : `${s.base_url || 'AI_BASE_URL'} ${s.model}${s.key ? ' ' + s.key : ''}`).join('\n'))}</textarea>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div><label>Max reply tokens</label><input type="number" data-f="max_tokens" value="${r.max_tokens}"></div><div><label>Max calls per day</label><input type="number" data-f="daily_cap_calls" value="${r.daily_cap_calls}"></div></div>
        ${use.length ? `<ul class="rows" style="border:1px solid var(--line);border-radius:8px">${use.map(u => `<li><b>${esc(u.model)}</b><span class="s">${u.calls} calls · ${Math.round((u.ok / u.calls) * 100)}% ok · ${u.avg_ms} ms avg · ${u.tin + u.tout} tokens</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">No calls yet.</p>'}
        <div><button class="btn primary" data-save>Save</button></div>
      </div></section>`;
    }).join('')}</div>`;
  $$('[data-save]').forEach(b => b.onclick = async () => {
    const sec = b.closest('[data-task]');
    const chain = sec.querySelector('textarea').value.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[0]).map(p => p[0] === 'workers-ai'
      ? { provider: 'workers-ai', model: p[1] }
      : { provider: 'openai-compat', base_url: p[0] === 'AI_BASE_URL' ? undefined : p[0], model: p[1], key: p[2] });
    try {
      await edit(() => api(`/api/models/${sec.dataset.task}`, { method: 'PUT', body: { chain, max_tokens: +sec.querySelector('[data-f=max_tokens]').value, daily_cap_calls: +sec.querySelector('[data-f=daily_cap_calls]').value } }));
      toast('Saved');
    } catch (e) { if (e.message !== 'Edit cancelled') toast(e.message); }
  });
}

router();
