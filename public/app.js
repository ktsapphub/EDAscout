// EDAScout front end: dashboard, Source Manager, Models, Listen + Ask. No framework, no build step.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let me = { owner: false, publicView: false };
let dash = null;
let filter = 'All';

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), action ? 8000 : 3500);
}

const fmtDate = d => d ? new Date(d.length === 10 ? d + 'T12:00:00Z' : d.replace(' ', 'T') + (d.includes('T') || d.endsWith('Z') ? '' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: d.length === 10 ? 'UTC' : undefined }) : '';
const ago = d => {
  if (!d) return 'never';
  const t = Date.parse(d.includes('T') ? d : d.replace(' ', 'T') + 'Z');
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const favicon = url => { try { return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`; } catch { return ''; } };
const isFresh = d => d && Date.now() - Date.parse(d.replace(' ', 'T') + 'Z') < 30 * 3600e3;

function countUp(el, to) {
  if (reduce || !Number.isFinite(to)) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = t => { const p = Math.min(1, (t - t0) / 600); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function swap(render) {
  if (document.startViewTransition && !reduce) document.startViewTransition(render); else render();
}

// ---------------- router ----------------
async function router() {
  const r = location.hash.replace(/^#\/?/, '') || 'home';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r));
  me = await api('/api/me').catch(() => me);
  document.querySelectorAll('.owner-only').forEach(el => (el.hidden = !me.owner));
  $('#askFab').hidden = !(me.owner || me.publicView);
  if (!me.owner && !me.publicView) return renderLogin();
  if (r === 'admin' && me.owner) return renderSources();
  if (r === 'models' && me.owner) return renderModels();
  if (r === 'login') return renderLogin();
  return renderDashboard();
}
addEventListener('hashchange', router);

// ---------------- login ----------------
function renderLogin() {
  setStatus('idle', 'Private');
  app.innerHTML = `<section class="login">
    <h1>EDAScout</h1>
    <p class="muted">Norfolk economic development, every morning, with sources. Enter your owner key to open the dashboard on this device.</p>
    <form id="lf"><label for="k">Owner key</label><input id="k" type="password" autocomplete="current-password" required><button class="btn primary">Open dashboard</button><p class="muted" id="lerr" role="alert"></p></form>
  </section>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { key: $('#k').value.trim() } }); location.hash = '#/'; router(); }
    catch (err) { $('#lerr').textContent = err.message; }
  };
}

// ---------------- dashboard ----------------
function setStatus(kind, text) {
  const s = $('#runStatus');
  s.querySelector('.dot').className = `dot ${kind}`;
  s.querySelector('.txt').textContent = text;
}

function skeleton() {
  const sk = n => Array.from({ length: n }, (_, i) => `<div class="sk" style="width:${92 - i * 9}%"></div>`).join('');
  return `<div class="zone"><div class="divider"><span>Today</span></div>
    <div class="grid"><div class="span-12 kpis">${'<div class="kpi"><div class="sk" style="height:28px;width:50%"></div><div class="sk" style="width:70%"></div></div>'.repeat(4)}</div>
    <section class="panel brief span-12"><div class="panel-head"><h2>Today's Brief</h2></div><div class="panel-body">${sk(5)}</div></section></div></div>
    <div class="zone"><div class="divider"><span>Signals &amp; EDA</span></div><div class="grid">
    <section class="panel span-7"><div class="panel-head"><h2>Signal Board</h2></div><div class="panel-body">${sk(8)}</div></section>
    <section class="panel span-5"><div class="panel-head"><h2>EDA Watch</h2></div><div class="panel-body">${sk(6)}</div></section></div></div>`;
}

async function renderDashboard() {
  if (!dash) app.innerHTML = skeleton();
  try { dash = await api('/api/dashboard'); }
  catch (e) { if (e.status === 401) return renderLogin(); app.innerHTML = `<p class="empty">Couldn't load the dashboard: ${esc(e.message)}</p>`; return; }
  swap(() => drawDashboard(dash));
}

function drawDashboard(d) {
  const run = d.lastRun;
  if (!run) setStatus('idle', 'No scan yet');
  else if (!run.finished_at) setStatus('live', 'Scanning sources…');
  else setStatus(run.ok ? '' : 'bad', `Last scan ${ago(run.finished_at)} · ${run.items_new} new`);

  const tags = ['All', ...new Set(d.signals.flatMap(s => (s.tags || '').split(',').filter(Boolean)))].slice(0, 9);
  const nextEda = d.kpis.nextEda;
  const healthy = d.health?.ok || 0, total = (d.health?.ok || 0) + (d.health?.failing || 0) + (d.health?.pending || 0);

  app.innerHTML = `
  <div class="zone"><div class="divider"><span>Today</span></div>
    <div class="grid">
      <div class="span-12 kpis">
        <div class="kpi"><div class="n" data-count="${d.kpis.new_signals || 0}">0</div><div class="l">New signals in the last day</div></div>
        <div class="kpi"><div class="n date">${nextEda ? fmtDate(nextEda) : '—'}</div><div class="l">Next EDA meeting (first Wed., noon)</div></div>
        <div class="kpi"><div class="n" data-count="${d.kpis.total_items || 0}">0</div><div class="l">Items tracked with sources</div></div>
        <div class="kpi"><div class="n" data-count="${healthy}">0</div><div class="l">Sources healthy of ${total}</div><div class="bar"><i data-w="${total ? Math.round(healthy / total * 100) : 0}"></i></div></div>
      </div>
      ${briefPanel(d)}
    </div>
  </div>

  <div class="zone"><div class="divider"><span>Signals &amp; EDA</span></div>
    <div class="grid">
      <section class="panel span-7 ${d.signals.some(s => isFresh(s.found_at)) ? 'has-new' : ''}">
        <div class="panel-head"><h2>Signal Board</h2><span class="meta">${d.signals.length} active · ranked by relevance</span></div>
        <div class="filters" role="toolbar" aria-label="Filter signals">${tags.map(t => `<button class="chip ${t === filter ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="panel-body flush scroll"><div class="cards" id="signalCards">${signalCards(d.signals)}</div></div>
      </section>
      ${edaPanel(d, nextEda)}
    </div>
  </div>

  <div class="zone"><div class="divider"><span>City Hall &amp; Latest</span></div>
    <div class="grid">
      <section class="panel span-6"><div class="panel-head"><h2>City Hall Feed</h2><span class="meta">Council, Planning &amp; boards · iQM2</span></div>
        <div class="panel-body flush">${d.cityhall.length ? `<ul class="rows">${d.cityhall.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><span class="s">${esc(r.summary || '')}${r.summary ? ' · ' : ''}found ${ago(r.found_at)}</span></li>`).join('')}</ul>` : '<p class="empty" style="padding:16px">No City Hall items yet. They appear after the first scan.</p>'}</div></section>
      <section class="panel span-6"><div class="panel-head"><h2>Latest from all sources</h2><span class="meta">newest first</span></div>
        <div class="panel-body flush scroll" style="max-height:520px">${d.latest.length ? `<ul class="rows">${d.latest.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><span class="s"><span class="src"><img src="${favicon(r.url)}" alt="" loading="lazy"> ${esc(r.source)}</span> · ${ago(r.found_at)}</span></li>`).join('')}</ul>` : '<p class="empty" style="padding:16px">Nothing yet.</p>'}</div></section>
    </div>
  </div>

  ${d.weekly ? `<div class="zone"><div class="divider"><span>Weekly Roll-up</span></div><div class="grid"><section class="panel span-12"><div class="panel-head"><h2>Week ${esc(d.weekly.period)}</h2></div><div class="panel-body"><ol>${d.weekly.bullets.map(b => `<li style="margin:6px 0">${esc(b.text)} ${b.items.map(i => d.cites[i] ? `<a href="${esc(d.cites[i].url)}" target="_blank" rel="noopener">[${esc(d.cites[i].source)}]</a>` : '').join(' ')}</li>`).join('')}</ol></div></section></div></div>` : ''}`;

  app.querySelectorAll('[data-count]').forEach(el => countUp(el, +el.dataset.count));
  requestAnimationFrame(() => app.querySelectorAll('[data-w]').forEach(el => (el.style.width = el.dataset.w + '%')));
  wireDashboard(d);
}

function briefPanel(d) {
  const b = d.brief;
  const body = b && b.bullets?.length
    ? `<ol id="briefList">${b.bullets.map((x, i) => `<li data-i="${i}"><div>${esc(x.text)}<div class="cite">${x.items.map(id => d.cites[id] ? `<a href="${esc(d.cites[id].url)}" target="_blank" rel="noopener" title="${esc(d.cites[id].title)}">${esc(d.cites[id].source)} ↗</a>` : '').join('')}</div></div></li>`).join('')}</ol>`
    : `<p class="empty">No brief yet. ${me.owner ? 'Open <a href="#/admin" style="color:#fff">Sources</a> and press <b>Run scan now</b> to build the first one.' : 'The first one arrives after the morning scan.'}</p>`;
  return `<section class="panel brief span-12">
    <div class="panel-head"><h2>Today's Brief</h2>
      <span class="meta">${b ? `${fmtDate(b.period)} · ${b.generated === 'rules' ? 'rules-only (AI budget saved)' : 'AI summary'} · every line linked` : ''}</span>
      ${b?.bullets?.length ? `<button class="listen" id="listen"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span class="wave"><i></i><i></i><i></i><i></i></span><span class="lt">Listen</span></button>` : ''}
    </div>
    <div class="panel-body">${body}</div>
  </section>`;
}

function signalCards(list) {
  const shown = list.filter(s => filter === 'All' || (s.tags || '').split(',').includes(filter));
  if (!shown.length) return `<p class="empty" style="padding:16px">${list.length ? 'No signals with this tag.' : 'No signals yet. They appear after the first scan.'}</p>`;
  return shown.map((s, i) => {
    const rule = s.rule_hit || (s.rule_hits || '').split(',')[0];
    return `<article class="card ${isFresh(s.found_at) ? 'fresh' : ''} ${s.status === 'pinned' ? 'pinned' : ''}" style="animation-delay:${Math.min(i, 12) * 40}ms" data-id="${s.id}">
      <h3><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></h3>
      <div class="score" title="Relevance score"><b>${s.score}</b><span class="bar"><i data-w="${s.score}"></i></span></div>
      ${s.summary ? `<p class="sum">${esc(s.summary)}</p>` : ''}
      ${s.why ? `<p class="why"><b>Why it matters:</b> ${esc(s.why)}</p>` : ''}
      <div class="cmeta">
        <span class="src"><img src="${favicon(s.url)}" alt="" loading="lazy"> ${esc(s.source)}</span>
        <span>· ${s.published_at ? fmtDate(s.published_at) : 'found ' + ago(s.found_at)}</span>
        ${(s.tags || '').split(',').filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        ${rule ? `<span class="tag rule">${esc(rule)}</span>` : ''}
        <a href="${esc(s.url)}" target="_blank" rel="noopener">Source ↗</a>
        ${me.owner ? `<span class="card-actions"><button class="mini" data-act="${s.status === 'pinned' ? 'new' : 'pinned'}">${s.status === 'pinned' ? 'Unpin' : 'Pin'}</button><button class="mini" data-act="dismissed">Dismiss</button></span>` : ''}
      </div>
    </article>`;
  }).join('');
}

function edaPanel(d, nextEda) {
  const dt = nextEda ? new Date(nextEda + 'T12:00:00Z') : null;
  const meets = d.meetings.map(m => {
    const a = m.actions || {};
    const acts = (a.actions || []).filter(x => x.item).slice(0, 4);
    return `<div class="meet">
      <div class="k"><span class="kind">${esc(m.body)} ${esc(m.doc_kind)}</span><span>${m.meeting_date ? fmtDate(m.meeting_date) : ''}</span><a href="${esc(m.doc_url)}" target="_blank" rel="noopener" style="margin-left:auto">PDF ↗</a></div>
      ${m.summary ? `<h3>${esc(m.summary)}</h3>` : ''}
      ${acts.length ? `<ul>${acts.map(x => `<li>${esc(x.item)}${x.outcome ? ` · <i>${esc(x.outcome)}</i>` : ''}${x.amount_usd ? ` <span class="amt">${esc(x.amount_usd)}</span>` : ''}${x.vote ? ` <span class="amt">${esc(x.vote)}</span>` : ''}</li>`).join('')}</ul>`
        : (a.amounts?.length ? `<ul><li>Amounts in document: ${a.amounts.slice(0, 4).map(x => `<span class="amt">${esc(x)}</span>`).join(' ')}</li></ul>` : '')}
    </div>`;
  }).join('');
  return `<section class="panel span-5 ${d.meetings.some(m => isFresh(m.created_at)) ? 'has-new' : ''}">
    <div class="panel-head"><h2>EDA Watch</h2><span class="meta">agendas &amp; minutes</span></div>
    ${dt ? `<div class="next-meet"><div class="cal"><div class="m">${dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</div><div class="d">${dt.getUTCDate()}</div></div>
      <div><b>Next EDA meeting</b><div class="muted" style="font-size:13px">Wednesday, 12:00 PM · 999 Waterside Dr., Suite 400<br>Budget committee 11:15 AM. <a href="https://norfolkdevelopment.com/target-industries/the-norfolk-economic-development-authority/" target="_blank" rel="noopener">Confirm on EDA page ↗</a></div></div></div>` : ''}
    <div class="panel-body flush scroll" style="max-height:640px">${meets || '<p class="empty" style="padding:16px">Agendas and minutes appear after the first scan.</p>'}</div>
  </section>`;
}

function wireDashboard(d) {
  app.querySelectorAll('.chip').forEach(c => c.onclick = () => {
    filter = c.dataset.tag;
    app.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    swap(() => { $('#signalCards').innerHTML = signalCards(d.signals); bars(); wireCards(d); });
  });
  bars();
  wireCards(d);
  const L = $('#listen');
  if (L) L.onclick = () => listen(d, L);
}
const bars = () => requestAnimationFrame(() => app.querySelectorAll('.score [data-w]').forEach(el => (el.style.width = el.dataset.w + '%')));

function wireCards(d) {
  app.querySelectorAll('.card [data-act]').forEach(b => b.onclick = async () => {
    const card = b.closest('.card'), id = +card.dataset.id, status = b.dataset.act;
    try {
      await api(`/api/signals/${id}`, { method: 'POST', body: { status } });
      const s = d.signals.find(x => x.id === id);
      if (status === 'dismissed') {
        d.signals = d.signals.filter(x => x.id !== id);
        card.style.transition = 'opacity .25s, transform .25s'; card.style.opacity = 0; card.style.transform = 'translateX(16px)';
        setTimeout(() => { $('#signalCards').innerHTML = signalCards(d.signals); bars(); wireCards(d); }, 250);
        toast('Signal dismissed', { label: 'Undo', run: async () => { await api(`/api/signals/${id}`, { method: 'POST', body: { status: 'new' } }); renderDashboard(); } });
      } else { s.status = status; $('#signalCards').innerHTML = signalCards(d.signals); bars(); wireCards(d); }
    } catch (e) { toast(e.message); }
  });
}

// ---------------- Listen (free, uses the browser's own voice) ----------------
function speakText(text, { onstart, onend } = {}) {
  if (!('speechSynthesis' in window)) { toast('Your browser cannot read aloud.'); return; }
  const u = new SpeechSynthesisUtterance(text.replace(/\bEDA\b/g, 'E.D.A.').replace(/\bNRHA\b/g, 'N.R.H.A.'));
  u.rate = 1.02; u.lang = 'en-US';
  const v = speechSynthesis.getVoices().find(v => /en-US/.test(v.lang) && /natural|neural|samantha|google us/i.test(v.name));
  if (v) u.voice = v;
  u.onstart = onstart; u.onend = onend; u.onerror = onend;
  speechSynthesis.speak(u);
}
function listen(d, btn) {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); btn.classList.remove('speaking-now'); btn.querySelector('.lt').textContent = 'Listen'; app.querySelectorAll('#briefList li').forEach(l => l.classList.remove('speaking')); return; }
  btn.classList.add('speaking-now'); btn.querySelector('.lt').textContent = 'Stop';
  const items = d.brief.bullets;
  speakText(`Here is your Norfolk economic development brief for ${fmtDate(d.brief.period)}.`);
  items.forEach((b, i) => speakText(b.text, {
    onstart: () => { app.querySelectorAll('#briefList li').forEach(l => l.classList.toggle('speaking', +l.dataset.i === i)); },
    onend: () => { if (i === items.length - 1) { btn.classList.remove('speaking-now'); btn.querySelector('.lt').textContent = 'Listen'; app.querySelectorAll('#briefList li').forEach(l => l.classList.remove('speaking')); } },
  }));
}

// ---------------- Ask (type or talk) ----------------
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
  pending.className = 'msg bot'; pending.textContent = 'Looking through the sources…';
  log.append(pending); log.scrollTop = log.scrollHeight;
  try {
    const r = await api('/api/ask', { method: 'POST', body: { q } });
    pending.innerHTML = `${esc(r.answer)}${r.sources.length ? `<div class="srcs">${r.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source)}: ${esc(s.title.slice(0, 80))} ↗</a>`).join('')}</div>` : ''}`;
    if (spoken) { const orb = $('#askMic'); speakText(r.answer, { onstart: () => orb.classList.add('speaking'), onend: () => orb.classList.remove('speaking') }); }
  } catch (e) { pending.textContent = e.message; }
  log.scrollTop = log.scrollHeight;
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$('#askMic').onclick = () => {
  if (!SR) { toast('Voice input works in Chrome, Edge and Safari. You can type instead.'); return; }
  const rec = new SR(); const orb = $('#askMic');
  rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
  rec.onstart = () => orb.classList.add('listening');
  rec.onend = () => orb.classList.remove('listening');
  rec.onerror = () => orb.classList.remove('listening');
  rec.onresult = e => ask(e.results[0][0].transcript, true);
  speechSynthesis?.cancel(); rec.start();
};

// ---------------- Source Manager ----------------
let sources = [];
let tierTab = 'all';
async function renderSources() {
  setStatus('idle', 'Admin');
  app.innerHTML = `<div class="page-head"><div><h1>Sources</h1><p>Everything EDAScout reads. Add any public page, RSS feed or PDF; pause or remove sources anytime.</p></div>
    <div class="actions"><button class="btn" id="runNow">Run scan now</button><button class="btn primary" id="addBtn">+ Add source</button></div></div>
    <div id="runLog"></div>
    <div class="tabs" role="toolbar">${[['all', 'All'], ['1', 'Tier 1 · Norfolk'], ['2', 'Tier 2 · Region'], ['3', 'Tier 3 · Trends'], ['paused', 'Paused'], ['removed', 'Removed']].map(([k, l]) => `<button class="chip ${k === tierTab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}<input id="q" placeholder="Search sources" aria-label="Search sources"></div>
    <section class="panel"><div class="panel-body flush" style="overflow:auto"><table class="src-table"><thead><tr><th>Health</th><th>Source</th><th>Tier</th><th>Type</th><th>Cadence</th><th>Last new</th><th>Active</th><th></th></tr></thead><tbody id="srcRows"><tr><td colspan="8"><div class="sk"></div><div class="sk"></div></td></tr></tbody></table></div></section>
    <section class="panel" style="margin-top:20px"><div class="panel-head"><h2>Settings</h2></div><div class="panel-body" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="toggle" id="pubToggle" aria-pressed="${me.publicView}" aria-label="Public view"></button>
      <div><b>Public view</b><div class="muted" style="font-size:13px">Off = only you (signed in) can see the dashboard. On = anyone with the link can view; only you can change sources.</div></div>
      <button class="btn" id="logout" style="margin-left:auto">Sign out on this device</button></div></section>`;
  $('#addBtn').onclick = () => openDrawer();
  $('#runNow').onclick = runNow;
  $('#q').oninput = drawRows;
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tierTab = b.dataset.tab; app.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b)); drawRows(); });
  $('#pubToggle').onclick = async e => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    await api('/api/settings', { method: 'PATCH', body: { publicView: on } });
    e.currentTarget.setAttribute('aria-pressed', on); me.publicView = on; toast(on ? 'Dashboard is now viewable by link' : 'Dashboard is private');
  };
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.hash = '#/'; router(); };
  sources = await api('/api/sources');
  drawRows();
}

function health(s) {
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
    if (tierTab !== 'all' && String(s.tier) !== tierTab) return false;
    return true;
  }).filter(s => !q || `${s.name} ${s.url} ${s.tags}`.toLowerCase().includes(q));
  $('#srcRows').innerHTML = list.length ? list.map(s => {
    const [h, ht] = health(s);
    return `<tr data-id="${s.id}" class="${s.deleted_at ? 'deleted' : ''}">
      <td><span class="health ${h}" title="${esc(ht)}"></span><span class="muted" style="font-size:12px">${esc(h === 'g' ? 'OK' : h === 'n' ? '—' : 'Check')}</span></td>
      <td><b>${esc(s.name)}</b> ${s.origin === 'recommended' ? '<span class="tag rule">recommended</span>' : s.origin === 'added' ? '<span class="tag">added</span>' : ''}<a class="u" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>${s.fail_count ? `<span class="u" style="color:var(--nfk-alert)">${esc(s.last_error || '')}</span>` : ''}</td>
      <td>${s.tier}</td><td>${esc(s.kind)}</td><td>${esc(s.cadence)}</td>
      <td class="muted">${s.last_new ? ago(s.last_new) : '—'}<br><span style="font-size:12px">${s.item_count} items</span></td>
      <td>${s.deleted_at ? '' : `<button class="toggle" data-act="toggle" aria-pressed="${!!s.active}" aria-label="Active"></button>`}</td>
      <td><div class="row-actions">${s.deleted_at ? '<button class="mini" data-act="restore">Restore</button>' : '<button class="mini" data-act="test">Test now</button><button class="mini" data-act="edit">Edit</button><button class="mini" data-act="remove">Remove</button>'}</div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">No sources here.</td></tr>';
  app.querySelectorAll('#srcRows [data-act]').forEach(b => b.onclick = () => rowAction(b));
}

async function rowAction(b) {
  const tr = b.closest('tr'), id = +tr.dataset.id, s = sources.find(x => x.id === id), act = b.dataset.act;
  try {
    if (act === 'toggle') {
      const on = b.getAttribute('aria-pressed') !== 'true';
      await api(`/api/sources/${id}`, { method: 'PATCH', body: { active: on } });
      s.active = on ? 1 : 0; b.setAttribute('aria-pressed', on); toast(on ? `${s.name} resumed` : `${s.name} paused`);
    } else if (act === 'remove') {
      await api(`/api/sources/${id}`, { method: 'DELETE' });
      tr.classList.add('removing');
      s.deleted_at = new Date().toISOString(); s.active = 0;
      setTimeout(drawRows, 250);
      toast(`Removed ${s.name}`, { label: 'Undo', run: async () => { await api(`/api/sources/${id}/restore`, { method: 'POST' }); s.deleted_at = null; s.active = 1; drawRows(); } });
    } else if (act === 'restore') {
      await api(`/api/sources/${id}/restore`, { method: 'POST' }); s.deleted_at = null; s.active = 1; drawRows(); toast(`Restored ${s.name}`);
    } else if (act === 'test') {
      b.disabled = true; b.textContent = 'Testing…';
      const r = await api(`/api/sources/${id}/test`, { method: 'POST' });
      b.disabled = false; b.textContent = 'Test now';
      openDrawer(s, r);
    } else if (act === 'edit') openDrawer(s);
  } catch (e) { toast(e.message); }
}

function openDrawer(src = null, testResult = null) {
  const edit = !!src;
  const back = document.createElement('div'); back.className = 'drawer-back';
  const el = document.createElement('aside'); el.className = 'drawer'; el.setAttribute('aria-label', edit ? 'Edit source' : 'Add source');
  el.innerHTML = `<header><h2>${edit ? 'Edit source' : 'Add a source'}</h2><button class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="body">
      ${edit ? `<div><label>Web address</label><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.url)}</a></div>`
        : `<div><label for="f-url">Web address (page, RSS feed or PDF)</label><div style="display:flex;gap:8px"><input id="f-url" type="url" placeholder="https://…" required><button class="btn" id="f-prev" type="button">Preview</button></div></div>`}
      <div id="f-preview">${testResult ? previewHtml(testResult) : ''}</div>
      <div><label for="f-name">Name</label><input id="f-name" value="${esc(src?.name || '')}" placeholder="e.g. Hampton Roads Alliance news"></div>
      <div class="two">
        <div><label for="f-tier">Tier</label><select id="f-tier">${[[1, '1 · Norfolk core'], [2, '2 · Regional context'], [3, '3 · Trends']].map(([v, l]) => `<option value="${v}" ${(src?.tier || 1) == v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label for="f-cad">How often</label><select id="f-cad">${['daily', 'weekly', 'monthly'].map(v => `<option ${(src?.cadence || 'daily') === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="two">
        <div><label for="f-kind">What it is</label><select id="f-kind">${[['news', 'News / announcements'], ['meetings', 'Meeting agendas & minutes'], ['cityhall', 'City Hall meetings list'], ['properties', 'Properties / listings'], ['grants', 'Grants / funding'], ['context', 'Plan or report (context)']].map(([v, l]) => `<option value="${v}" ${(src?.kind || 'news') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label for="f-tags">Tags</label><input id="f-tags" value="${esc(src?.tags || '')}" placeholder="Maritime, Downtown"></div>
      </div>
      <div><label for="f-kw">Only keep items mentioning (optional)</label><input id="f-kw" value="${esc(src?.keyword_filter || '')}" placeholder="Norfolk, Hampton Roads"></div>
    </div>
    <footer><button class="btn" data-close>Cancel</button><button class="btn primary" id="f-save">${edit ? 'Save changes' : 'Add source'}</button></footer>`;
  document.body.append(back, el);
  const close = () => { back.remove(); el.remove(); };
  back.onclick = close; el.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', k); } });
  (edit ? $('#f-name', el) : $('#f-url', el)).focus();

  if (!edit) $('#f-prev', el).onclick = async () => {
    const box = $('#f-preview', el), btn = $('#f-prev', el);
    btn.disabled = true; btn.textContent = 'Reading…';
    box.innerHTML = '<div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    try {
      const r = await api('/api/sources/preview', { method: 'POST', body: { url: $('#f-url', el).value, kind: $('#f-kind', el).value, keyword_filter: $('#f-kw', el).value } });
      box.innerHTML = previewHtml(r);
      if (!$('#f-name', el).value) $('#f-name', el).value = new URL(r.url).hostname.replace(/^www\./, '');
    } catch (e) { box.innerHTML = `<p style="color:var(--nfk-alert)">${esc(e.message)}</p>`; }
    btn.disabled = false; btn.textContent = 'Preview';
  };
  $('#f-save', el).onclick = async () => {
    const body = { name: $('#f-name', el).value, tier: +$('#f-tier', el).value, cadence: $('#f-cad', el).value, kind: $('#f-kind', el).value, tags: $('#f-tags', el).value, keyword_filter: $('#f-kw', el).value };
    try {
      if (edit) await api(`/api/sources/${src.id}`, { method: 'PATCH', body });
      else await api('/api/sources', { method: 'POST', body: { ...body, url: $('#f-url', el).value } });
      close(); toast(edit ? 'Saved' : 'Source added. It will be read on the next scan.');
      sources = await api('/api/sources'); drawRows();
    } catch (e) { toast(e.message); }
  };
}

function previewHtml(r) {
  if (r.ok === false) return `<p style="color:var(--nfk-alert)">Couldn't read it: ${esc(r.error)}</p>`;
  const c = r.candidates || [];
  return `<div class="preview"><div class="panel-head" style="background:transparent"><h2 style="font-size:13px">What EDAScout sees (${esc(r.method)})</h2><span class="meta">${c.length ? 'latest items' : ''}</span></div>
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
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (ev.type === 'start') line(`Reading ${ev.sources} sources…`);
        if (ev.type === 'source') line(ev.ok ? `<span class="ok">✓</span> ${esc(ev.name)}${ev.newItems ? ` · ${ev.newItems} new` : ''}` : `<span class="bad">✗</span> ${esc(ev.name)} · ${esc(ev.error)}`);
        if (ev.type === 'phase') line(ev.phase === 'brief' ? 'Writing today\'s brief…' : 'Summarizing new items…');
        if (ev.type === 'done') { line(`<span class="ok">Done.</span> ${ev.newItems} new items, ${ev.sourcesOk} sources OK, ${ev.sourcesFailed} failed, ${ev.llmCalls} AI calls.`); setStatus('', 'Scan finished just now'); }
        if (ev.type === 'error') line(`<span class="bad">Error:</span> ${esc(ev.error)}`);
      }
    }
  } catch (e) { line(`<span class="bad">${esc(e.message)}</span>`); }
  btn.disabled = false; btn.textContent = 'Run scan now';
  dash = null;
  sources = await api('/api/sources'); drawRows();
}

// ---------------- Models ----------------
async function renderModels() {
  setStatus('idle', 'Admin');
  app.innerHTML = '<div class="sk"></div>';
  const d = await api('/api/models');
  const label = { summarize: 'Summarize items', extract: 'Read meeting PDFs', synthesize: 'Write the brief', voice: 'Answer questions (Ask)' };
  app.innerHTML = `<div class="page-head"><div><h1>Models</h1><p>No job is tied to one AI company. Each job tries the cheapest model first and moves to the next only if the answer fails a check. Workers AI needs no key.</p></div></div>
    <p class="muted" style="margin:-6px 0 16px">Keys connected: ${d.keysConnected.length ? d.keysConnected.map(k => `<span class="tag">${esc(k)}</span>`).join(' ') : '<b>none</b>, so everything runs on Cloudflare Workers AI (included in your plan)'}. Add GEMINI_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY as Worker secrets to unlock those options.</p>
    <div class="grid">${d.routes.map(r => {
      const use = d.usage.filter(u => u.task === r.task);
      return `<section class="panel span-6" data-task="${esc(r.task)}"><div class="panel-head"><h2>${esc(label[r.task] || r.task)}</h2><span class="meta">${use.reduce((a, u) => a + u.calls, 0)} calls · 30 days</span></div>
      <div class="panel-body" style="display:grid;gap:10px">
        <label>Model chain, cheapest first (one per line: <code>workers-ai @cf/…</code> or <code>https://base-url model-name KEY_NAME</code>)</label>
        <textarea rows="4" style="font-family:var(--mono);font-size:12.5px">${esc(r.chain.map(s => s.provider === 'workers-ai' ? `workers-ai ${s.model}` : `${s.base_url || 'AI_BASE_URL'} ${s.model}${s.key ? ' ' + s.key : ''}`).join('\n'))}</textarea>
        <div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div><label>Max reply tokens</label><input type="number" data-f="max_tokens" value="${r.max_tokens}"></div><div><label>Max calls per day</label><input type="number" data-f="daily_cap_calls" value="${r.daily_cap_calls}"></div></div>
        ${use.length ? `<ul class="rows" style="border:1px solid var(--line);border-radius:8px">${use.map(u => `<li><b>${esc(u.model)}</b><span class="s">${u.calls} calls · ${Math.round((u.ok / u.calls) * 100)}% ok · ${u.avg_ms} ms avg · ${u.tin + u.tout} tokens</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">No calls yet.</p>'}
        <div><button class="btn primary" data-save>Save</button></div>
      </div></section>`;
    }).join('')}</div>`;
  app.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const sec = b.closest('[data-task]');
    const chain = sec.querySelector('textarea').value.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[0]).map(p => p[0] === 'workers-ai'
      ? { provider: 'workers-ai', model: p[1] }
      : { provider: 'openai-compat', base_url: p[0] === 'AI_BASE_URL' ? undefined : p[0], model: p[1], key: p[2] });
    try {
      await api(`/api/models/${sec.dataset.task}`, { method: 'PUT', body: { chain, max_tokens: +sec.querySelector('[data-f=max_tokens]').value, daily_cap_calls: +sec.querySelector('[data-f=daily_cap_calls]').value } });
      toast('Saved');
    } catch (e) { toast(e.message); }
  });
}

router();
