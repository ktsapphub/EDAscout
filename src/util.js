// Small helpers: safe URLs, polite fetching, HTML/RSS parsing, hashing.

export const UA = 'Mozilla/5.0 (compatible; EDAScout/1.0; +https://edascout.ktsapps.com) civic news monitor';

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|metadata\.google\.internal)$/i;
const PRIVATE_IP = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

/** Public http(s) URLs only: no IP literals in private ranges, no internal hostnames, no custom ports. */
export function safeUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  const h = u.hostname;
  if (!h.includes('.') || PRIVATE_HOST.test(h) || PRIVATE_IP.test(h)) return null;
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

export async function sha256(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** robots.txt check (cached a day in KV). Fails open only when robots.txt is missing. */
export async function robotsAllows(env, url) {
  const u = new URL(url);
  const key = `robots:${u.host}`;
  let rules = await env.KV.get(key, 'json').catch(() => null);
  if (!rules) {
    rules = [];
    try {
      const r = await fetch(`${u.origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok) rules = parseRobots(await r.text());
    } catch { /* unreachable robots = no rules */ }
    await env.KV.put(key, JSON.stringify(rules), { expirationTtl: 86400 }).catch(() => {});
  }
  const path = u.pathname + u.search;
  let allow = true, best = -1;
  for (const { type, p } of rules) {
    if (!p) continue;
    if (path.startsWith(p) && p.length > best) { best = p.length; allow = type === 'allow'; }
  }
  return allow;
}

function parseRobots(txt) {
  const out = [];
  let applies = false, sawAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!sawAgent) applies = false;
      sawAgent = true;
      if (v === '*' || /edascout/i.test(v)) applies = true;
    } else {
      sawAgent = false;
      if (applies) out.push({ type: k, p: v.replace(/\*.*$/, '') });
    }
  }
  return out;
}

/** Fetch with polite headers, timeout, size cap and conditional-GET support. */
export async function politeFetch(url, { etag, lastModified, accept, maxBytes = 6_000_000 } = {}) {
  const headers = { 'User-Agent': UA, Accept: accept || 'text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`Too large (${len} bytes)`);
  const isBinary = /pdf|octet-stream/i.test(type) || /\.pdf($|\?)/i.test(res.url);
  const body = isBinary ? await res.arrayBuffer() : await res.text();
  return { status: res.status, type, body, isBinary, finalUrl: res.url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

const RETRYABLE = /HTTP (403|406|409|429|5\d\d)|internal error|timed? ?out|network/i;

/**
 * Fetch that survives bot walls: polite fetch → one retry on 429/5xx → Cloudflare Browser Run (real headless browser).
 * robots.txt is checked by the caller first, so this never reads a page a site asked crawlers to avoid.
 */
export async function robustFetch(env, url, opts = {}) {
  try {
    return await politeFetch(url, opts);
  } catch (e) {
    const msg = String(e.message || e);
    if (!RETRYABLE.test(msg)) throw e;
    if (/HTTP (429|5\d\d)/.test(msg)) {
      await new Promise(r => setTimeout(r, 2500));
      try { return await politeFetch(url, opts); } catch { /* fall through to browser */ }
    }
    if (/\.pdf($|\?)/i.test(url)) {
      const buf = await browserBinary(env, url).catch(() => null);
      if (!buf) throw e;
      return { status: 200, type: 'application/pdf', body: buf, isBinary: true, finalUrl: url, viaBrowser: true };
    }
    if (!env?.BROWSER?.quickAction) throw e;
    const html = await browserHtml(env, url);
    if (!html) throw e;
    return { status: 200, type: 'text/html', body: html, isBinary: false, finalUrl: url, viaBrowser: true };
  }
}

/**
 * Download a file (e.g. an agenda PDF) through a real browser session: open the site's home page first
 * (so any bot check is passed the normal way), then fetch the file from inside that page.
 */
async function browserBinary(env, url) {
  if (!env?.BROWSER) return null;
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(new URL(url).origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const b64 = await page.evaluate(async u => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 15_000_000) throw new Error('Too large');
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, url);
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function browserHtml(env, url) {
  try {
    const out = await env.BROWSER.quickAction('content', { url, gotoOptions: { waitUntil: 'domcontentloaded', timeout: 30000 } });
    if (typeof out === 'string') return out;
    if (out instanceof Response) {
      const t = await out.text();
      try { const j = JSON.parse(t); return typeof j.result === 'string' ? j.result : null; } catch { return t; }
    }
    return typeof out?.result === 'string' ? out.result : null;
  } catch { return null; }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripTags(html) {
  return decode(String(html || '')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Main readable text of a page: <article> or <main> when present, else the body. */
export function mainText(html, max = 3000) {
  const pick = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
  return stripTags(pick).slice(0, max);
}

export function pageTitle(html) {
  return decode(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
}

export function pageDate(html) {
  const m = html.match(/<meta[^>]+(?:article:published_time|datePublished|pubdate)["'][^>]+content=["']([^"']+)/i)
    || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)/i);
  return m ? isoDate(m[1]) : null;
}

export function isoDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

const NAV = /^(home|about( us)?|contact( us)?|login|log in|sign in|sign up|subscribe|search|menu|skip to .*|privacy.*|terms.*|accessibility|facebook|twitter|x|linkedin|instagram|youtube|read more|learn more|more|next|previous|back|events|news|careers|donate|shop|cart|español|translate)$/i;

/** Links on a page with anchor text and a little following context (helps when anchors are just dates or "Agenda"). */
export function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href;
    try { href = new URL(decode(m[1]), baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(href)) continue;
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    // Context stops at the next/previous date so one row's text never bleeds into another (e.g. iQM2 meeting rows).
    let after = stripTags(html.slice(re.lastIndex, re.lastIndex + 900)).replace(/\s+/g, ' ').trim();
    const cut = after.search(DATE_RE);
    if (cut > 0) after = after.slice(0, cut);
    after = after.slice(0, 220).trim();
    const before = stripTags(html.slice(Math.max(0, m.index - 600), m.index)).replace(/\s+/g, ' ').trim().slice(-160);
    const key = href.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: href, text, after, before });
  }
  return out;
}

/** Keep links that look like content, not navigation. */
export function contentLinks(links, pageUrl, { pattern } = {}) {
  const host = new URL(pageUrl).host.replace(/^www\./, '');
  const re = pattern ? new RegExp(pattern, 'i') : null;
  return links.filter(l => {
    if (re) return re.test(l.url);
    const lhost = new URL(l.url).host.replace(/^www\./, '');
    const isPdf = /\.pdf($|\?)/i.test(l.url);
    if (lhost !== host && !isPdf) return false;
    if (l.url.replace(/\/$/, '') === pageUrl.replace(/\/$/, '')) return false;
    if (/\/(tag|category|author|page|wp-login|feed|cart|account)\b|\?(share|replytocom)=|mailto:|tel:/i.test(l.url)) return false;
    if (NAV.test(l.text)) return false;
    return isPdf || l.text.split(' ').length >= 4;
  });
}

/** Minimal RSS/Atom parser. */
export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const tag = n => b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i'))?.[1];
    const cdata = s => decode(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    const link = cdata(tag('link')).trim() || b.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || '';
    items.push({
      url: link.trim(),
      title: stripTags(cdata(tag('title'))),
      published: isoDate(cdata(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date'))),
      excerpt: stripTags(cdata(tag('description') || tag('summary') || tag('content:encoded') || tag('content'))).slice(0, 1500),
    });
  }
  return items.filter(i => i.url && i.title);
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE_RE = new RegExp(`\\b(${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+20\\d\\d\\b`, 'i');

/** The last date mentioned in a piece of text (e.g. the heading right before a PDF link). */
export function lastDateIn(s) {
  const all = String(s || '').match(new RegExp(DATE_RE.source, 'gi'));
  return all ? dateFromText(all[all.length - 1]) : null;
}
/** Pull a date like "April-1-2026" or "Oct 20, 2026" from a filename or title. */
export function dateFromText(s) {
  const t = decodeURIComponent(String(s || '')).replace(/[-_]+/g, ' ');
  const m = t.match(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'i'));
  if (m) { const d = new Date(`${m[1]} ${m[2]} ${m[3]} 12:00 UTC`); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
  const n = t.match(/\b(20\d\d)[ /.](\d{1,2})[ /.](\d{1,2})\b/);
  if (n) return `${n[1]}-${n[2].padStart(2, '0')}-${n[3].padStart(2, '0')}`;
  return null;
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const today = () => new Date().toISOString().slice(0, 10);
