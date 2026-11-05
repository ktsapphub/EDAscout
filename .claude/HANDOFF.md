# HANDOFF — EDA Scout

Updated 2026-11-05.

## Current state
- Production https://edascout.ktsapps.com and staging https://edascout-staging.ktsapps.com are live (Cloudflare Worker + D1 + KV + Workers AI + Browser Rendering).
- `main` deploys production, `staging` deploys the sandbox (hub-deploy.yml). Test on staging first.
- Full product/tech spec: docs/agents/edascout-spec.md (source of truth).

## What changed this round (2026-11-05)
- Ask chat bubbles were invisible (missing `forwards` on the fade-in); fixed.
- EDA meetings: backlog backfill of linked-but-unread agendas/minutes (13 months, 4 per run) with file-name year correction; OCR of scanned minutes via cloud browser + vision model.
- Synopsis per area rewrites only when its facts change; includes newest stories; rules fallback.
- Top signals and Signal Board newest first, last 30 days.
- Sources page: per-source auto-update status, "Check all sources", failed sources retry next run.
- Footer usage: site-wide across all areas, 7/14/30/60/90/YTD selector, area split.
- Staging sandbox: own D1/KV, banner, "Staging · copy production data" and "Staging · health check" workflows.

## Open issues
- Six sources return no items (see spec §11).
- USAspending HTTP 525 from Workers.
- Word-based crime filter; consider AI relevance check.

## Next steps
1. Confirm OCR'd minutes produce real summaries on staging, then on production.
2. Fix the six empty sources.
3. Optional AI relevance gate for local-news feeds.

## Key file map
- src/index.js — routes, dashboard payload, Ask, usage stats
- src/pipeline.js — scan, backfill, OCR, synopsis, EDA outlook, weekly
- src/util.js — fetch/robots/parsing, browser helpers (HTML, PDF bytes, PDF page images)
- src/llm.js — model routing, caps, logging; src/score.js — rules scoring; src/data.js — FRED, USAspending, money
- public/app.js, public/app.css, public/index.html — front end (no build)
- migrations/ — D1 schema (apply manually before deploying dependent code)

## Guidance docs
- docs/agents/edascout-spec.md
