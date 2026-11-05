# EDA Scout — product and technical spec

Version 3 · updated 2026-11-05 · owner: Bretton Key · repo `ktsapphub/EDAscout`

This is the single source of truth for what EDA Scout does and how it is built. Agents: read it before changing anything, and update the "Change log" and "Open items" sections in the same PR as your change.

## 1. Purpose

An open, always-current intelligence dashboard on Norfolk economic development for Norfolk Economic Development Authority (EDA) board members, city staff and residents. It reads public sources, summarizes them with links to the originals, tracks economic trends for Norfolk, Hampton Roads and Virginia, and explains what the EDA board did and is likely to take up next.

Principles:
- **Open to everyone.** No login to view, ask questions, listen, or run a scan. Only changes to sources and AI settings need the owner's edit key.
- **Every claim links to its source.** Summaries are machine-written; the original is the record.
- **Lowest possible AI cost.** Rules and deterministic extraction first; AI only for summaries, synopsis, meeting extraction, OCR of scanned minutes and Ask. Vendor-neutral (Workers AI first; Gemini/OpenAI/Grok optional fallbacks).
- **Robots.txt is always honored.** Sites that ask crawlers to stay out are kept as linked references, never fetched.

## 2. Environments

| | Production | Staging (sandbox) |
|---|---|---|
| URL | https://edascout.ktsapps.com | https://edascout-staging.ktsapps.com |
| Worker | `edascout` | `edascout-staging` |
| D1 | `edascout` (40f50a4c-e417-4cdd-a170-3da9eeece09d) | `edascout-staging` (f4583617-e0ea-4de7-b932-5d60cc65c53c) |
| KV | `edascout-cache` (46681e25…) | `edascout-staging-cache` (a5d50bba…) |
| Deploys from | push to `main` | push to `staging` |
| Scheduled refresh | every 6 h (00/06/12/18 UTC) | daily 11:30 UTC |
| Banner | none | orange "Staging sandbox" bar |

Staging never touches production data. Reset it with GitHub → Actions → **Staging · copy production data** (exports production read-only, replaces staging, clears staging usage and AI-call logs). **Staging · health check** tests both sites and can trigger a staging scan.

Recommended flow: change → push `staging` → verify on the sandbox → push `main`.

## 3. Architecture

One Cloudflare Worker (`src/index.js`) serves static assets from `public/` and the API under `/api/*` (`run_worker_first`). No build step, no framework.

| Binding | Use |
|---|---|
| `DB` (D1) | all data; schema in `migrations/0001…0006` |
| `KV` | dashboard cache (5 min, busted after each scan), trends cache (1 h), robots.txt cache, rate limits, Ask answer cache (15 min) |
| `AI` (Workers AI) | summaries, synopsis, meeting extraction, OCR, Ask; PDF text via `toMarkdown` |
| `BROWSER` (Browser Rendering) | fallback reader for sites that block plain fetches (403/429/5xx); reads PDFs inside a real browser session; renders scanned PDF pages for OCR |

Source files: `src/index.js` (routes, dashboard payload, Ask, usage), `src/pipeline.js` (scan, summaries, area synopsis, EDA outlook, meeting docs, OCR, backfill), `src/util.js` (fetching, robots, parsing, browser helpers), `src/score.js` (rules scoring), `src/llm.js` (vendor-neutral model router), `src/data.js` (FRED trends, USAspending, money extraction). Front end: `public/index.html`, `public/app.js`, `public/app.css`.

## 4. Data and sources

- ~48 sources, each tagged with an **area** (`norfolk`, `region`, `state`, `national`), a **kind** (`news`, `meetings`, `cityhall`, `properties`, `grants`, `context`, `reference`) and a **cadence** (`daily` = every 6-hour run, `weekly`, `monthly`).
- Area views: Norfolk shows Norfolk sources; Hampton Roads adds regional; Virginia adds state and national.
- Fetching: polite fetch with conditional GET → one retry on 429/5xx → cloud-browser fallback. Robots-blocked sites become `reference` (link only).
- Filters: per-source keyword filter; news sources also drop crime, crash, fire and weather stories; titles that are page code are dropped.
- Trends: FRED series (unemployment, jobs, listing price, active listings, days on market, permits, house price index, income per person, real GDP) for each area, refreshed weekly.
- Federal awards: USAspending (currently returns HTTP 525 from Workers; see open items).

## 5. Scan pipeline (`runDaily`)

1. Read due sources (cadence elapsed, never read, or failed last time) with 4 parallel workers; diff against `seen_links`.
2. EDA meetings source: new agenda/minutes PDFs are read, plus a **backlog** of up to 4 linked-but-unread documents per run from the last 13 months (newest first). File names with a wrong year are corrected from the upload folder when that lands on a Wednesday.
3. Scanned PDFs (no text layer, e.g. copier-scanned approved minutes) are **OCR'd**: pages rendered in the cloud browser with pdf.js, transcribed by a vision model (Llama 4 Scout, Gemma 3 fallback), max 5 pages.
4. Deterministic extraction of dollar amounts and votes; AI extraction of summary, why it matters and actions.
5. Score items 0–100 by rules (Norfolk specificity 30, industry 25, materiality 25, timeliness 20); AI may nudge only the 30–70 band.
6. Trends refresh (weekly), federal awards, item summaries (budgeted).
7. **Area synopsis** for each area: rewritten only when its facts change (trend direction labels + newest stories from the last 14 days + money). Falls back to a rules-written synopsis if AI is unavailable or capped.
8. **EDA Outlook** (last meeting, initiatives in motion, likely next topics) when new EDA docs arrive or weekly.
9. Weekly roll-up on Mondays (12–18 UTC run).
10. Bust dashboard caches.

AI budget: 40 calls per run (`MAX_LLM_CALLS_PER_RUN`); daily caps per task in `model_routes` (summarize 40, extract 30, synthesize 6, voice 100). Every call is logged in `llm_calls`.

## 6. Dashboard

Header: area switch (Norfolk / Hampton Roads / Virginia), Dashboard · Sources · Models, last-updated status, countdown to the next scheduled update, refresh button. If the last update is older than 7 hours, the page starts a background scan by itself.

Sections can be **moved, collapsed or hidden** (remembered per device and area; "Reset layout").

1. **Today** — KPI row (Norfolk: days to next EDA meeting, new signals, dollars mentioned, healthy sources; regions: unemployment, jobs, GDP, list price). **Today's Brief**: lead chip (EDA countdown or "X of Y indicators improved"), **Synopsis** (shows "updated … ago"), **Top signals** (score ≥ 75, last 30 days, newest first; if none, the three closest), **Area by area** (one line per section with jump links), **The numbers**. **Listen** reads it all aloud with highlighting.
2. **EDA Board Meetings** — next meeting card (countdown, place, Listen to the outlook), **EDA Outlook** (last meeting · in motion · likely next, each linked to evidence), **Meetings awaiting minutes** (past first-Wednesday meetings without posted minutes), **Previous meetings** (13 months, each with agenda/minutes PDFs, synopsis, actions, Listen, full details).
3. **Trends** — cards per metric; tapping opens a chart with 7D/30D/90D/YTD/1Y/5Y and line/area/bar (monthly series explain when a short range has no new reading).
4. **Signals** — score histogram (75 bar marked), tag filters, Signal Board newest first (pinned on top), Pin/Dismiss (edit key).
5. **Money & Housing** — donut by money type, money tracker list, federal awards.
6. **City Hall & Latest** — Norfolk City Hall feed and newest items from all sources.
7. **What's heating up** — topic momentum (8 weeks) and plans/research library.
8. **Weekly Roll-up** — dark story cards, AI roll-up.

Footer: **Site usage · all areas** — visitors, page views, visitors today, share by area and a daily trend line, with a range selector (7/14/30/60/90 days, year to date). Counts unique browsers by anonymous hashed ID; no IPs; bots and headless browsers excluded.

Story modal: summary, why it matters, actions, money, excerpt, related items, Listen, open original.

**Ask** (floating button): type or speak; answers in ≤ 3 sentences from tracked items, EDA documents and FRED figures only, with source links; answers are spoken when asked by voice. 9-second time limit, then it falls back to the best-matching items.

## 7. Sources page

- Tabs by area plus **Needs attention**, Paused, Removed; search.
- **Auto-update check** per source: On schedule (last read, next check), Last read failed (retries next run), Overdue, Failing (3+ failures), Waiting, Link only, Paused. Summary bar: "X of Y auto-updating sources are on schedule".
- **Check all sources** (edit key): reads every active source now without saving and marks each row "Reads fine · N items", "Reads, but found no items", or the error.
- Add/edit drawer with live preview, area selector, kind (incl. "Link only"), cadence, keyword filter. Test now, pause, remove with undo, restore.
- **Run scan now** with streamed progress (public: once per 20 minutes).

## 8. Access and limits

Public: view, Ask (20/hour per IP), Listen, Run scan (1 per 20 min). Edit key (HttpOnly cookie `eda_key`, hash in `prefs.admin_key_hash`): sources, models, pin/dismiss, Check all sources. Login attempts limited to 10 per 15 minutes.

## 9. Deploy and Mission Control

- Mission Control (build.ktsapps.com) workflows live in `.github/workflows/`: `claude-hub.yml` (agent runs; builds a dry-run deploy after installing packages), `hub-deploy.yml` (deploys `main` → production, `staging` → staging; Node 22), `staging-data.yml`, `staging-check.yml`.
- Mission Control reads `CLAUDE.md`, `.claude/HANDOFF.md`, `README.md` and `.hub/launch.json` (environments and health checks) to keep its project memory and Launch tab current.
- D1 migrations are applied manually (D1 console, Cloudflare MCP, or `wrangler d1 migrations apply --remote`) before deploying code that needs them; staging gets them through **Staging · copy production data**.

## 10. Data model (D1)

`sources`, `seen_links`, `items`, `citations`, `signals`, `meetings`, `briefs` (kinds: `overview_<area>`, `eda_outlook`, `weekly`, legacy `daily`), `runs`, `model_routes`, `llm_calls`, `metrics`, `money`, `awards`, `visits`, `area_views`, memory tables (`entities`, `entity_events`, `threads`, `thread_items`, `mentions`, `prefs`, `feedback`, `notes`).

## 11. Open items

- Six sources read but return no items: Coastal Virginia Magazine, Norfolk Development blog, NRHA, 13News Now, Grants.gov, Governor's news releases. Fix their URLs or keyword filters.
- USAspending returns HTTP 525 from Workers; federal awards panel empty.
- Crime filter is word-based; consider an AI relevance check before scoring.
- Sep 2 and Oct 7, 2026 EDA minutes are not posted on the EDA site yet; they appear automatically when posted.

## 12. Change log

- **2026-11-05** — Ask answers visible again (animation fix). EDA meeting backlog backfill (13 months) and OCR of scanned minutes. Synopsis rewrites when its facts change, newest stories included, rules fallback. Top signals and Signal Board newest first (last 30 days). Sources auto-update check and Check all sources; failed sources retry next run. Site-wide usage with ranges and area split. Weekly roll-up readable. Off-topic news filter. Staging sandbox live with data copy and health check workflows. Mission Control deploy check installs packages; deploy uses Node 22.
- **2026-10-20** — v2: open access, area switch, trends, money & housing, EDA Outlook, story modal, motion, movable sections, browser fallback for blocked sites, 6-hour refresh with countdown.
