// Structured data feeds: FRED trend series (Norfolk · Hampton Roads · Virginia), USAspending federal awards, and the money tracker.
import { UA } from './util.js';

// One row per metric × geography. Every series was checked on fred.stlouisfed.org; any that fails simply hides.
export const METRICS = [
  { key: 'unemp', label: 'Unemployment rate', unit: '%', group: 'Jobs', better: 'down', series: { norfolk: 'VANORF5URN', region: 'VIRG251URN', state: 'VAURN' } },
  { key: 'jobs', label: 'Nonfarm jobs', unit: 'k', group: 'Jobs', better: 'up', series: { region: 'VIRG251NAN', state: 'VANAN' } },
  { key: 'list_price', label: 'Median home listing price', unit: '$', group: 'Housing', better: 'neutral', series: { norfolk: 'MEDLISPRI51710', region: 'MEDLISPRI47260', state: 'MEDLISPRIVA' } },
  { key: 'listings', label: 'Homes for sale (active listings)', unit: '', group: 'Housing', better: 'neutral', series: { norfolk: 'ACTLISCOU51710', region: 'ACTLISCOU47260', state: 'ACTLISCOUVA' } },
  { key: 'dom', label: 'Median days on market', unit: 'days', group: 'Housing', better: 'neutral', series: { norfolk: 'MEDDAYONMAR51710', region: 'MEDDAYONMAR47260', state: 'MEDDAYONMARVA' } },
  { key: 'permits', label: 'New homes permitted', unit: '', group: 'Housing', better: 'up', series: { region: 'VIRG251BPPRIV', state: 'VABPPRIV' } },
  { key: 'hpi', label: 'House price index', unit: 'idx', group: 'Housing', better: 'neutral', series: { norfolk: 'ATNHPIUS51710A', region: 'ATNHPIUS47260Q', state: 'VASTHPI' } },
  { key: 'income', label: 'Income per person', unit: '$', group: 'Economy', better: 'up', series: { norfolk: 'PCPI51710', region: 'VIRG251PCPI', state: 'VAPCPI' } },
  { key: 'gdp', label: 'Real GDP', unit: '$M', group: 'Economy', better: 'up', series: { norfolk: 'REALGDPALL51710', region: 'RGMP47260', state: 'VARQGSP' }, scale: { norfolk: 0.001 } },
];

const allSeries = () => METRICS.flatMap(m => Object.values(m.series));

/** Pull every FRED series (CSV, no key needed). Runs weekly from the daily scan; ~25 small requests. */
export async function refreshMetrics(env, { force = false } = {}) {
  const last = await env.KV.get('metrics:refreshed').catch(() => null);
  if (!force && last && Date.now() - Number(last) < 6 * 864e5) return { skipped: true };
  const since = new Date(Date.now() - 12 * 365 * 864e5).toISOString().slice(0, 10);
  let ok = 0, failed = [];
  for (const id of allSeries()) {
    try {
      const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.text()).trim().split('\n').slice(1)
        .map(l => l.split(',')).filter(([d, v]) => /^\d{4}-\d\d-\d\d$/.test(d) && v && v !== '.' && !isNaN(+v));
      if (!rows.length) throw new Error('no data');
      const st = env.DB.prepare('INSERT OR REPLACE INTO metrics (series, date, value) VALUES (?, ?, ?)');
      for (let k = 0; k < rows.length; k += 80) await env.DB.batch(rows.slice(k, k + 80).map(([d, v]) => st.bind(id, d, +v)));
      ok++;
      await new Promise(r => setTimeout(r, 1100));   // FRED asks for 1 request/second
    } catch (e) { failed.push(`${id}: ${e.message}`); }
  }
  await env.KV.put('metrics:refreshed', String(Date.now())).catch(() => {});
  return { ok, failed };
}

/** Trend payload for one geography: latest value, change vs a year ago, and a sparkline series. */
export async function trends(env, geo) {
  const out = [];
  for (const m of METRICS) {
    const id = m.series[geo];
    if (!id) continue;
    const { results } = await env.DB.prepare('SELECT date, value FROM metrics WHERE series = ? ORDER BY date').bind(id).all();
    if (!results.length) continue;
    const scale = m.scale?.[geo] || 1;
    const pts = results.map(r => ({ d: r.date, v: r.value * scale }));
    const lastPt = pts[pts.length - 1];
    const yearAgo = [...pts].reverse().find(p => Date.parse(p.d) <= Date.parse(lastPt.d) - 360 * 864e5);
    const recent = pts.filter(p => Date.parse(p.d) >= Date.parse(lastPt.d) - 5 * 365 * 864e5);
    out.push({
      key: m.key, label: m.label, unit: m.unit, group: m.group, better: m.better, series: id,
      source: `https://fred.stlouisfed.org/series/${id}`,
      latest: lastPt, yearAgo: yearAgo || null,
      change: yearAgo ? lastPt.v - yearAgo.v : null,
      pct: yearAgo && yearAgo.v ? (lastPt.v - yearAgo.v) / Math.abs(yearAgo.v) * 100 : null,
      points: recent,
    });
  }
  return out;
}

// ---------- USAspending: federal contracts and grants with place of performance in Norfolk ----------
export async function refreshAwards(env, { force = false } = {}) {
  const last = await env.KV.get('awards:refreshed').catch(() => null);
  if (!force && last && Date.now() - Number(last) < 2.5 * 864e5) return { skipped: true };
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const groups = [['A', 'B', 'C', 'D'], ['02', '03', '04', '05']];
  let n = 0;
  for (const codes of groups) {
    const res = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        filters: { time_period: [{ start_date: start, end_date: end }], award_type_codes: codes, place_of_performance_locations: [{ country: 'USA', state: 'VA', county: '710' }] },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Description', 'Start Date', 'generated_internal_id'],
        sort: 'Award Amount', order: 'desc', limit: 25, page: 1,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`USAspending HTTP ${res.status}`);
    const { results = [] } = await res.json();
    const st = env.DB.prepare('INSERT OR REPLACE INTO awards (id, recipient, amount, agency, description, start_date, url) VALUES (?,?,?,?,?,?,?)');
    const rows = results.filter(r => r['Award Amount'] > 0).map(r => st.bind(
      String(r['generated_internal_id'] || r['Award ID']), r['Recipient Name'] || '', +r['Award Amount'] || 0, r['Awarding Agency'] || '',
      String(r['Description'] || '').slice(0, 300), r['Start Date'] || null,
      r['generated_internal_id'] ? `https://www.usaspending.gov/award/${encodeURIComponent(r['generated_internal_id'])}` : 'https://www.usaspending.gov/search'));
    if (rows.length) await env.DB.batch(rows);
    n += rows.length;
  }
  await env.KV.put('awards:refreshed', String(Date.now())).catch(() => {});
  return { ok: n };
}

// ---------- Money tracker: dollar figures in sources, with the sentence they came from (rules only, no AI) ----------
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(million|billion|thousand|m|bn|k)?\b/gi;
const KIND_RULES = [
  ['grant', /\bgrant|award(ed)?|funding|appropriat|allocat/i],
  ['investment', /\binvest|capital|expan|relocat|headquarter|facility|build|construct|develop/i],
  ['approval', /\bapprov|vote|resolution|authoriz|agreement|incentive|ordinance/i],
  ['housing', /\bhousing|apartment|home|rent|afford|residential|units\b/i],
  ['budget', /\bbudget|revenue|tax|fiscal|bond|levy|assessment/i],
];

export function extractMoney(text) {
  const out = [];
  const s = String(text || '').replace(/\s+/g, ' ');
  for (const m of s.matchAll(MONEY_RE)) {
    let v = parseFloat(m[1].replace(/,/g, ''));
    const unit = (m[2] || '').toLowerCase();
    if (unit.startsWith('b')) v *= 1e9; else if (unit === 'million' || unit === 'm') v *= 1e6; else if (unit === 'thousand' || unit === 'k') v *= 1e3;
    if (!isFinite(v) || v < 10000) continue;           // ignore small figures (fees, prices of single items)
    const a = Math.max(0, s.lastIndexOf('. ', m.index) + 2);
    const bEnd = s.indexOf('. ', m.index);
    const sentence = s.slice(a, bEnd < 0 ? Math.min(s.length, m.index + 200) : bEnd + 1).trim().slice(0, 260);
    const kind = (KIND_RULES.find(([, re]) => re.test(sentence)) || ['mention'])[0];
    out.push({ amount: v, label: sentence, kind });
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.amount) && seen.add(x.amount)).slice(0, 6);
}

export async function storeMoney(env, itemId, text) {
  const rows = extractMoney(text);
  if (!rows.length) return 0;
  const st = env.DB.prepare('INSERT OR IGNORE INTO money (item_id, amount, label, kind) VALUES (?,?,?,?)');
  await env.DB.batch(rows.map(r => st.bind(itemId, r.amount, r.label, r.kind)));
  return rows.length;
}
