# EDA Scout — agent notes

Read `.claude/HANDOFF.md` first, then `docs/agents/edascout-spec.md` (the spec; keep its Change log and Open items current in every PR).

- Stack: one Cloudflare Worker (`src/`) + static front end (`public/`), no build step. D1 `DB`, KV `KV`, Workers AI `AI`, Browser Rendering `BROWSER`.
- Branches: `main` → production (edascout.ktsapps.com); `staging` → sandbox (edascout-staging.ktsapps.com). Verify on staging before main.
- Never use production data in staging except through the "Staging · copy production data" workflow.
- New tables/columns: add `migrations/NNNN_name.sql`; it must be applied to the remote D1 before code that needs it ships.
- Keep AI usage low: rules first; every model call goes through `chat()` in `src/llm.js` (logged, capped) except OCR, which counts against the run budget.
- Honor robots.txt; blocked sites stay as `reference` sources.
- Front end: no framework; respect `prefers-reduced-motion`; any element animated from opacity 0 needs `forwards`/`both`.
- Check locally: `npx wrangler dev` (use a test config without the BROWSER binding for `--local`).
