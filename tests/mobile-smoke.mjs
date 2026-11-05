// Mobile smoke test against a live EDA Scout URL. Records page errors, long main-thread tasks,
// unexpected re-renders and layout overflow, and saves screenshots. Usage: node tests/mobile-smoke.mjs <url> <outdir>
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const [url = 'https://edascout.ktsapps.com', out = 'mobile-report'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const report = [];
const browser = await chromium.launch();
for (const name of ['iPhone 14', 'Pixel 7']) {
  const ctx = await browser.newContext({ ...devices[name], recordVideo: { dir: `${out}/video-${name.replace(/\W/g, '')}` } });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  const r = { device: name, errors: [], console: [], requests: {}, steps: [] };
  page.on('pageerror', e => r.errors.push(String(e.stack || e).slice(0, 400)));
  page.on('console', m => m.type() === 'error' && r.console.push(m.text().slice(0, 200)));
  page.on('request', q => { const p = new URL(q.url()).pathname; if (p.startsWith('/api/')) r.requests[p] = (r.requests[p] || 0) + 1; });
  await page.addInitScript(() => {
    window.__long = []; window.__renders = 0;
    try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); } catch {}
    new MutationObserver(ms => ms.forEach(m => { if (m.target.id === 'app' && m.type === 'childList') window.__renders++; })).observe(document, { childList: true, subtree: true });
  });
  const step = async (label, fn) => {
    const t0 = Date.now();
    try { await fn(); r.steps.push({ label, ok: true, ms: Date.now() - t0 }); }
    catch (e) { r.steps.push({ label, ok: false, error: String(e.message || e).slice(0, 200) }); }
    await page.screenshot({ path: `${out}/${name.replace(/\W/g, '')}-${r.steps.length}-${label.replace(/\W+/g, '_')}.png` }).catch(() => {});
  };
  await step('load', async () => { await page.goto(url + '/#/', { waitUntil: 'load', timeout: 45000 }); await page.waitForSelector('#today', { timeout: 20000 }); await page.waitForTimeout(2500); });
  await step('idle 20s (watch for re-renders)', async () => { const a = await page.evaluate(() => window.__renders); await page.waitForTimeout(20000); r.rendersWhileIdle = (await page.evaluate(() => window.__renders)) - a; });
  await step('scroll page', async () => { for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(250); } await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(500); });
  await step('tap a top signal', async () => { await page.locator('#today .carousel .story:not([aria-hidden]) button.read').first().tap({ timeout: 8000 }); await page.waitForSelector('#modal:not([hidden])', { timeout: 8000 }); await page.waitForTimeout(800); await page.locator('#modal [data-close]').first().tap(); });
  await step('expand an area', async () => { await page.locator('.ar-item .area-head').first().tap({ timeout: 8000 }); await page.waitForTimeout(800); });
  await step('switch to Hampton Roads', async () => { await page.locator('.scope [data-geo="region"]').tap(); await page.waitForTimeout(3000); });
  await step('open a trend chart', async () => { await page.locator('#trends .metric').first().tap({ timeout: 8000 }); await page.waitForSelector('#modal:not([hidden])', { timeout: 8000 }); await page.waitForTimeout(800); await page.locator('#modal [data-close]').first().tap(); });
  await step('open Ask and type', async () => { await page.locator('#askFab').tap(); await page.locator('#askInput').fill('What is the unemployment rate?'); await page.locator('#askForm button[type=submit]').tap(); await page.waitForTimeout(6000); r.askAnswer = (await page.locator('#askLog .msg.bot').last().innerText().catch(() => '')).slice(0, 160); await page.locator('#askClose').tap(); });
  await step('Sources page', async () => { await page.locator('[data-nav="sources"]').tap(); await page.waitForTimeout(3000); });
  r.longTasks = await page.evaluate(() => ({ count: window.__long.length, worst: Math.max(0, ...window.__long), over200: window.__long.filter(x => x > 200).length }));
  r.renders = await page.evaluate(() => window.__renders);
  r.overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  report.push(r);
  await ctx.close();
}
await browser.close();
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
