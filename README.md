# EDAScout

A daily, source-linked command view of Norfolk economic development: EDA agendas and minutes, City Hall meetings, deals, properties, grants and regional signals. Every summary links to its original.

**Live:** https://edascout.ktsapps.com (open to everyone) · **Sandbox:** https://edascout-staging.ktsapps.com

Full spec: [docs/agents/edascout-spec.md](docs/agents/edascout-spec.md).

## What it does

- **Refreshes every 6 hours** (00/06/12/18 UTC); the header counts down to the next update. Unchanged pages are skipped.
- **Today's Brief** per area (Norfolk, Hampton Roads, Virginia): AI synopsis that updates as sources update, top signals (score 75+, newest first), a line per section, key numbers. **Listen** reads it aloud.
- **EDA Board Meetings:** next meeting, EDA Outlook (last meeting, in motion, likely next), meetings awaiting minutes, and previous meetings with spoken synopses. Scanned minutes are read with OCR.
- **Trends** (FRED) with full charts, **Signals**, **Money & Housing**, **City Hall & Latest**, **What's heating up**, **Weekly roll-up**. Sections can be moved, collapsed or hidden.
- **Ask:** type or speak; answers only from tracked sources, with links.
- **Sources** page with an auto-update check per source and "Check all sources".
- **Site usage** across all areas with a 7/14/30/60/90-day or year-to-date selector.

## Stack

One Cloudflare Worker (`src/`) serves the static dashboard (`public/`) and the API, plus:

| Binding | Resource |
| --- | --- |
| `DB` | D1 `edascout` (schema in `migrations/`) |
| `KV` | `edascout-cache` (dashboard cache, robots.txt cache) |
| `AI` | Workers AI (summaries, synopsis, PDF reading, OCR of scanned minutes, Ask) |
| `BROWSER` | Browser Rendering (blocked sites, PDFs, scanned-page rendering) |

No build step and no framework.

## Deploys

Mission Control's **Mission Control Deploy** workflow deploys `main` → production and `staging` → the sandbox. Test on staging first. Reset the sandbox's data with **Staging · copy production data** (GitHub → Actions).

Database changes: add a new file in `migrations/` and run `npm run db:migrate` (or apply it in the D1 console).

## Optional AI keys

The app runs on Workers AI alone. To let a job fall back to another provider, add any of these as Worker secrets (Cloudflare dashboard → edascout → Settings → Variables and Secrets), then reorder the chain on the Models page:

`GEMINI_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, or `AI_BASE_URL` + `OMNIROUTE_API_KEY` for OmniRoute.

## Edit key

Viewing is open to everyone; only source and model changes need the edit key. It is stored only as a SHA-256 hash in D1 (`prefs.admin_key_hash`). To change it:

```sql
INSERT OR REPLACE INTO prefs (key, value) VALUES ('admin_key_hash', '<sha256 of the new key>');
```

## Local development

```bash
npm install
npm run db:local   # create local tables + seed
npm run dev        # http://localhost:8787
```

## Guardrails

- Polite crawling: identified user agent, robots.txt respected, conditional GETs, 4 sources at a time, a few page fetches per source.
- Only public http(s) URLs can be added (private/internal addresses are blocked).
- AI sees only the fetched text; numbers are copied, not invented; if the AI budget is used up, the brief falls back to a rules-only version that is still cited.
- Independent project. Not affiliated with the City of Norfolk or the Norfolk EDA.

See `docs/SPEC.md` for the full product spec and roadmap (memory, property map, grants radar, live voice).
