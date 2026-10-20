# EDAScout

A daily, source-linked command view of Norfolk economic development: EDA agendas and minutes, City Hall meetings, deals, properties, grants and regional signals. Every summary links to its original.

**Live:** https://edascout.ktsapps.com (private by default; sign in with your owner key)

## What it does

- **Scans every morning at 6:00 AM ET** (10:00 UTC cron). Unchanged pages are skipped, so a quiet day costs almost nothing.
- **Today's Brief:** up to 5 bullets, each linked to its sources. **Listen** reads it aloud using your browser's own voice (free).
- **Signal Board:** items ranked 0–100 by Norfolk relevance, industry fit, dollars/jobs/square feet, and timeliness. Pin or dismiss.
- **EDA Watch:** next meeting (first Wednesday, noon) and the latest agendas/minutes, with dollar amounts and votes pulled from the PDFs.
- **City Hall Feed:** Council, Planning Commission, EDA, NRHA and related board meetings from iQM2.
- **Weekly roll-up:** written on Mondays.
- **Ask:** type or speak a question; answers come only from tracked sources, with links.
- **Sources** page: add any public page, RSS feed or PDF (with a live preview), pause, edit, remove (with undo), "Test now", health dots, and **Run scan now** with live progress.
- **Models** page: no job is tied to one AI vendor. Each job tries the cheapest model first (Cloudflare Workers AI, included in the Workers plan) and moves to the next only if the answer fails a check. Daily call caps per job.

## Stack

One Cloudflare Worker (`src/`) serves the static dashboard (`public/`) and the API, plus:

| Binding | Resource |
| --- | --- |
| `DB` | D1 `edascout` (schema in `migrations/`) |
| `KV` | `edascout-cache` (dashboard cache, robots.txt cache) |
| `AI` | Workers AI (summaries, PDF reading via `toMarkdown`, Ask) |

No build step and no framework.

## Deploys

Pushes to `main` deploy automatically through **Cloudflare Workers Builds** (Cloudflare dashboard → Workers & Pages → edascout → Settings → Build, connected to this repo). Deploy command: `npx wrangler deploy`.

Database changes: add a new file in `migrations/` and run `npm run db:migrate` (or apply it in the D1 console).

## Optional AI keys

The app runs on Workers AI alone. To let a job fall back to another provider, add any of these as Worker secrets (Cloudflare dashboard → edascout → Settings → Variables and Secrets), then reorder the chain on the Models page:

`GEMINI_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, or `AI_BASE_URL` + `OMNIROUTE_API_KEY` for OmniRoute.

## Owner key

The owner key is stored only as a SHA-256 hash in D1 (`prefs.admin_key_hash`). To change it:

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
