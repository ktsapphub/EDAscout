# EDAScout — Spec

> Standalone app in `ktsapphub/EDAscout`. Mission Control references below are optional integrations, not dependencies. Phase 1 is built; see README.

As of Oct 20, 2026 · Owner: Bretton Key

A daily-refreshed, AI-summarized command view of Norfolk Economic Development Authority activity (meetings, properties, deals, regional signals and social stories) at **edascout.ktsapps.com**, built entirely on Cloudflare, with every summary linked to its sources, a memory that tracks stories over time, and a voice mode you can talk to.

## Purpose & users

The command center answers one question each morning: **what moved in Norfolk economic development since yesterday, and why it matters.** It turns scattered agendas, minutes, listings, press releases, regional reports and social posts into one scannable view, with a link back to every original.

- **Primary user:** Bretton, an EDA applicant and civic builder who wants to walk into any meeting already briefed.
- **Secondary users (later, via share links):** council members and staff, Downtown Norfolk Council partners, NFK Currents, local founders.

**Must do**
- Refresh daily (6:00 AM ET) and publish a weekly roll-up (Mondays 6:30 AM ET).
- Summarize in plain language, never without a source link and an as-of date.
- Flag *signals* (deals, property moves, grant windows, agenda items, regional shifts) and score them for relevance to Norfolk's target industries.
- Remember entities and story threads over time (see Memory).
- Let the owner add, pause and remove sources from the front end (see Source Manager).
- Tell the EDA story visually, with a short-form social wall.
- Let the owner **listen** to the brief and **ask** follow-ups by voice.

**Out of scope for v1:** user accounts beyond the owner, paid data feeds (CoStar, LoopNet API), scraping logged-in social platforms.

## Architecture

```
Sources ──▶ Daily run (Workflow, 6:00 AM ET) ──▶ Storage (D1 · R2 · KV · Vectorize) ──▶ edascout.ktsapps.com
              fetch, diff, extract                                                    dashboard panels
              score + summarize + memory                                              Listen (MP3)
              brief, audio, index                                                     Ask: text + voice
            Weekly roll-up (Workflow, Mon 6:30 AM ET) ──▶ Storage
            Both runs ──▶ Mission Control (run reports, re-run on demand)
            Runs + voice agent ──▶ AI Gateway or OmniRoute (any provider: Workers AI, Gemini, GPT, Grok, Claude…; cheapest-first per task)
```

Everything runs on Cloudflare. Cron-triggered Workflows do the fetching and AI work, results land in D1/R2/KV/Vectorize, and the site, audio and voice agent only read from storage. Pages load instantly and AI cost stays tied to scheduled runs plus on-demand questions.

## Dashboard panels

One Norfolk-blue-and-white, map-centered "ops room" screen on desktop; a single stacked feed on phone. Every card shows source favicon, as-of date, and a **Source ↗** link.

| Panel | What it shows | Refresh | Interaction |
| --- | --- | --- | --- |
| **Today's Brief** (top bar) | 5-bullet AI summary of the last 24 hours + ▶ Listen | Daily | Play audio; tap a bullet to jump to its card |
| **Signal Board** | Ranked cards (deals, expansions, grants, agenda items, regional shifts), 0–100 score + tag (Maritime, Advanced Mfg, Health/Bio, Professional Services, Real Estate, Workforce, Federal/Defense) | Daily | Filter by tag, sort by score/date, "Why this matters", "For you" sort, pin/dismiss |
| **EDA Watch** | Next EDA meeting (first Wednesday, noon, 999 Waterside Dr — confirm monthly), latest agenda/minutes summaries, votes and $ approved | Daily check; deep parse on new PDF | Open PDF, see vote tallies |
| **City Hall Feed** | Council + Planning Commission items touching economic development (iQM2) | Daily | Click through to iQM2 |
| **Property Map** | City/downtown available properties, opportunity zones, Innovation Corridor outline, recent parcel sales | Daily listings, weekly parcels | Pins with price, size, zoning; layer toggles |
| **Regional Pulse** | Port volumes, Hampton Roads jobs/unemployment (BLS/FRED), Beige Book takeaways, ODU forecasts | Weekly / on release | Sparklines, "compare to last month" |
| **Strategy Tracker** | NFK2050, Inclusive Economic Development Strategy, Hampton Roads Playbook, CEDS goals, with signals linked to each goal | Weekly | Goal → related signals |
| **Funding & Grants Radar** | Open grants that fit Norfolk (PIDP, EDA, GO Virginia, VEDP), deadline countdowns | Daily | Deadline chips, link to NOFO |
| **Story Wall** | Short-form social posts and videos as story threads | Daily | Swipeable reel, play in place |
| **Weekly Roll-up** | Archive of weekly briefs + 3-minute audio | Weekly | Read, listen, share link |
| **Ask (voice + text)** | Floating mic + chat drawer answering from indexed data with citations | On demand | Talk, type, follow links |

Header KPI strip: new signals today · deadlines in next 14 days · next public meeting · last successful run.

Admin pages (behind Cloudflare Access): **/sources** (Source Manager) and **/memory**.

## Visual design

Norfolk colors: **Norfolk Blue #225081**, **White #FFFFFF**, **Norfolk Green #90BA39**. White page, blue structure, green reserved for "new, live, positive."

| Token | Value | Used for |
| --- | --- | --- |
| `--nfk-blue` | #225081 | Header bar, panel titles, primary buttons, links, map outlines, headings |
| `--nfk-blue-900` | #16365A (derived) | Body text on white, dark-mode page background |
| `--nfk-blue-50` | #EAF0F7 (derived) | Panel header bands, hover rows, table stripes, skeletons |
| `--nfk-white` | #FFFFFF | Page and card backgrounds |
| `--nfk-green` | #90BA39 | New-signal badges, live run dot, score bars, active toggles, success |
| `--nfk-green-50` | #F1F7E6 (derived) | Highlight band behind today's new items |
| `--nfk-alert` | #C8553D (derived) | Deadlines < 7 days, failed sources only |

**Contrast rule:** green #90BA39 is ~2.3:1 on white, too light for text. Use it for fills, bars, dots and icons only; text on green is Norfolk Blue. Blue #225081 on white is ~8.3:1 and carries text.

### Dividers and layout
- 12-column grid, 24 px gutters; each panel is a white card with a 1 px `--nfk-blue` rule at 15% opacity.
- Every panel opens with a **blue header band** (name, as-of time, source count) and a 3 px green left edge when it has new items today.
- Full-width **section dividers** split the page into four zones: *Today* (brief + KPIs) · *Signals & EDA* · *Place & Pulse* (map, metrics, strategy) · *Story & Archive*. Each divider = thin blue rule + zone name in small caps.
- Mobile: zones stack in order, dividers stay, panels collapse to tappable headers; no horizontal scroll at 375 px.
- Optional dark mode: #16365A page, cards #1E4570, green unchanged.

### Motion and graphics
| Element | Motion | Timing |
| --- | --- | --- |
| KPI strip | Count up on load/refresh | 600 ms ease-out |
| Signal cards | Slide up + fade, staggered | 40 ms stagger, 220 ms each |
| Live run status | Green dot pulses during a run, solid when done | 1.6 s loop |
| Regional Pulse | Sparklines draw left→right; slow metrics ticker under header | 800 ms |
| Property Map | Pins drop in; new listings ring-pulse green once | 300 ms |
| Score bars | Fill with blue→green gradient | 400 ms |
| Listen / voice | Waveform while audio plays; voice orb breathes when listening, ripples when speaking | Tied to audio level |
| Panel changes | Cross-fade via View Transitions API on filter change | 200 ms |
| Loading | Blue-50 skeleton shimmer, never spinners | — |
| Header graphic | Subtle animated line motif of the Elizabeth River/harbor, white on blue | 20 s loop |

Rules: nothing > 800 ms except ambient loops; no motion that blocks reading; everything off under `prefers-reduced-motion`. CSS + the small Motion library only.

Footer on every page: "Independent project. Not affiliated with the City of Norfolk or the Norfolk EDA." No city logos or seals.

## Source registry

Seeded from this list into D1 `sources` (D1 is the source of truth after seeding; `sources.yaml` is seed/export only). Strip `utm_*` params on ingest. **Tier 1** = Norfolk core, daily · **Tier 2** = regional context · **Tier 3** = trends, weekly. All rows below ship in the default list and can be removed in the Source Manager.

### Tier 1: Norfolk core (daily)
| Source | Pull | Method |
| --- | --- | --- |
| [Norfolk EDA page](https://norfolkdevelopment.com/target-industries/the-norfolk-economic-development-authority/) | Board, mission, meeting schedule, links to agenda/minutes PDFs | HTML diff |
| EDA agendas & minutes PDFs (norfolkdevelopment.com/wp-content/uploads/…, e.g. [Apr 1 2026 agenda](https://norfolkdevelopment.com/wp-content/uploads/2026/04/April-1-2026-EDA-Agenda.pdf)) | Items, votes, $ amounts, projects | PDF parse + AI extract |
| [Norfolk Development home](https://norfolkdevelopment.com/) | Announcements, programs | HTML diff |
| [Norfolk Business Blog](https://norfolkdevelopment.com/norfolk-business-blog/) | Expansions, relocations, openings | RSS/HTML |
| Norfolk Development Available Properties, Location-based Incentives Map, Opportunity Zones | City-listed sites, incentive zones | HTML diff |
| [Target Industries](https://norfolkdevelopment.com/target-industries/) | Industry taxonomy for tagging | Weekly HTML |
| [iQM2 City Council portal](https://norfolkcityva.iqm2.com/citizens/default.aspx) | Council, Planning Commission, board agendas | HTML + PDF |
| [Downtown Norfolk commercial real estate](https://www.downtownnorfolk.org/business/commercial-real-estate) | Downtown listings | HTML diff |
| [Downtown Norfolk business directory](https://www.downtownnorfolk.org/business/business-directory) | New/closed businesses (diff) | Weekly HTML diff |
| Norfolk Open Data Portal (Socrata) | Permits, property sales, business licenses | Socrata API |
| [Norfolk GIS parcel service](https://gisshare.norfolk.gov/pubserver/rest/services/OpenData/Property_Information_Group_OpenData/MapServer/2/iteminfo) | Parcel polygons | ArcGIS REST, weekly |
| [Norfolk Innovation Corridor](https://downtownnorfolk.org/go/norfolk-innovation-corridor) | Tech-zone events, startups | HTML/RSS |
| [Port Infrastructure Development Program](https://www.transportation.gov/rural/grant-toolkit/port-infrastructure-development-program-pidp) | Grant cycles, awards | Weekly HTML diff |
| Grants.gov + SAM.gov / USAspending APIs | Open grants; federal awards with Norfolk place of performance | API |
| Norfolk Redevelopment and Housing Authority (NRHA) | St. Paul's area, redevelopment sites, board agendas | HTML + PDF |
| Norfolk Planning Department / zoning & site plan applications | Early project signals | HTML diff + open data |
| Local news: Virginian-Pilot business, WHRO, WAVY, 13NewsNow, Inside Business, Coastal Virginia Magazine | Coverage mentioning Norfolk + development keywords | RSS + keyword filter |

### Tier 2: Norfolk plans + Hampton Roads context
| Source | Pull | Cadence |
| --- | --- | --- |
| [NFK2050 Comprehensive Plan](https://www.norfolk.gov/6551/Adopted-Plan) | Goals, land-use pillars (embed once) | Monthly |
| [Inclusive Economic Development Strategy](https://www.norfolk.gov/DocumentCenter/View/64512/Norfolk-Economic-Development-Strategy) | Strategy goals | Monthly |
| [Port of Virginia infrastructure & workforce](https://www.portofvirginia.com/the-future/economic-development/infrastructure-workforce/) + newsroom + Virginia Port Authority board | TEU volumes, capital projects | Monthly |
| [Hampton Roads Playbook](https://hamptonroadsplaybook.com/wp-content/uploads/2025/10/Hampton-Roads-Playbook-Executive-Summary.pdf) | Regional target sectors | Monthly |
| [Hampton Roads Alliance CEDS](https://hamptonroadsalliance.com/ceds/) + Alliance news | Regional priorities, project wins | Weekly |
| [ODU State of the Region 2026](https://digitalcommons.odu.edu/sor_reports/229/) | Regional pillars, forecasts | On release |
| [ODU State of the Commonwealth](https://www.odu.edu/article/state-of-the-commonwealth-report-old-dominion-university-economists-examine-effects-of) | Statewide context | On release |
| VEDP announcements, GO Virginia Region 5, Hampton Roads Executive Roundtable | State deals, regional grants | Weekly |
| BLS LAUS/CES + FRED (Virginia Beach-Norfolk-Newport News MSA) | Unemployment, jobs, wages | Monthly API |
| Virginia Employment Commission labor market data | Norfolk jobs by industry | Monthly |
| [Virginia Business](https://virginiabusiness.com/) economic development coverage | Statewide deals and people | RSS |
| Norfolk Airport Authority (ORF) | Passenger/cargo trends | Monthly |
| Hampton Roads Military & Federal Facilities Alliance (HRMFFA) | Defense/federal presence | Weekly |
| Hampton Roads Transportation Planning Organization (HRTPO) | Transportation projects | Weekly |
| Hampton Roads Chamber + Greater Norfolk Corporation | Business community priorities | Weekly |
| ODU Strome Entrepreneurial Center / IIE + NSU Innovation Center | Startups, talent pipeline | Weekly |

### Tier 3: Southeast + trends (weekly; embedded as context, never cited as Norfolk news)
| Source | Use |
| --- | --- |
| [Atlanta Fed Beige Book (Oct 14, 2026)](https://www.atlantafed.org/what-we-study/regional-economy/beige-book/2026/10/14/beige-book-glp-1s-affecting-demand-for-poultry-alcohol) + [Regional Economy](https://www.atlantafed.org/what-we-study/regional-economy) | Southeast conditions |
| Richmond Fed Beige Book (Fifth District, covers Virginia) + Richmond Fed manufacturing/services surveys | Virginia conditions |
| [Site Selectors Guild 2025](https://siteselectorsguild.com/research/state-of-site-selection-2025/) | Site selection trends |
| [Brookings: Mapping the AI Economy](https://www.brookings.edu/articles/mapping-the-ai-economy-which-regions-are-ready-for-the-next-technology-leap/) | AI readiness lens |
| [PwC Site Selection & Labor](https://www.pwc.com/us/en/services/audit-assurance/library/us-site-selection-labor-dynamics.html) | Labor + reshoring lens |
| [WEF Future of Jobs 2025](https://www.weforum.org/publications/the-future-of-jobs-report-2025/in-full/2-jobs-outlook/) | Workforce lens |
| Dominion Energy offshore wind (CVOW) updates | Offshore wind supply chain |

Exact URLs for rows without a link are discovered and confirmed by `eda-source-scout` during seeding; a source that can't be confirmed is seeded `active=false`.

## Source Manager (/sources)

The owner adds and removes sources from the dashboard. Behind Cloudflare Access.

- **Add:** paste a URL → auto-detect type (RSS, HTML, PDF folder, known API) → live preview of 3 recent items with AI summaries → set name, tier, cadence, tags, keyword filter → save.
- **Remove:** soft delete; fetching stops, past items/citations stay; "Restore" brings it back; undo toast for 8 s.
- **Pause/resume** toggle (green when active). **Edit** name, tier, cadence, tags, keyword filters. **Test now** runs one fetch.
- **Health:** last fetched, last new item, failure count, green/amber/red dot.
- **Suggestions inbox:** monthly `eda-source-scout` proposals with Approve/Dismiss.
- **Import/export:** CSV, OPML, YAML.
- **Layout:** filterable table (tier tabs, search, health filter), "Add source" side drawer, row actions on hover, rows animate in/out.
- **API:** `GET /api/sources`, `POST /api/sources/preview`, `POST /api/sources`, `PATCH /api/sources/:id`, `DELETE /api/sources/:id` (soft), `POST /api/sources/:id/test`. Every change → `source_changes` audit table.
- **Guardrails:** public http/https URLs only (block private/internal IPs), robots.txt checked before save, per-domain rate limits.

## Daily run & weekly roll-up

Both are **Cloudflare Workflows** started by Cron Triggers; each step retries independently and a failed source never blocks the brief. Each run posts a report to Mission Control (`MC_WEBHOOK_URL`).

### Daily run: 6:00 AM ET (`0 10 * * *` UTC during EDT; `0 11 * * *` during EST)
1. **Fetch** active sources (ETag/Last-Modified, hash, skip unchanged).
2. **Extract** HTML → text; PDFs → text + page numbers; APIs → rows. Raw → R2.
3. **Diff** vs last snapshot.
4. **Classify & score** (tags + 0–100).
5. **Summarize** each item: 1–2 sentences + "why it matters" + citations.
6. **Signals:** score ≥ 60 or a watch rule (new EDA/Council vote, grant deadline < 30 days, property ≥ 20,000 sq ft, named company expansion, Port volume release).
7. **Memory update** (entities, threads, mentions).
8. **Brief:** 5 cited bullets from today's signals; no repeats of what memory says was already told.
9. **Audio:** TTS → MP3 in R2 (60–90 s).
10. **Index** new chunks to Vectorize.
11. **Publish & notify:** D1 write, KV bust, run report.

### Weekly roll-up: Mondays 6:30 AM ET (`30 10 * * 1` during EDT)
1. Pull 7 days of signals, briefs, metrics, posts, threads.
2. Cluster into 3–5 themes.
3. Write: Top 5 moves · What the EDA did · Property watch · Regional pulse (deltas computed in code) · Strategy progress · Coming up · Story of the week.
4. 3-minute audio + page at `/weekly/YYYY-Www`.
5. Source health re-score; flag stale (> 30 days) and failing (> 3 runs).

### Reliability
- One failed source = warning chip on its panel, not a failed run.
- Every summary stores the exact source text it came from.
- Polite crawling: identified user-agent, robots.txt, ≤ 1 req/s per domain.

## AI layer

**Vendor-neutral. No task requires Claude.** All AI calls go through ONE OpenAI-compatible adapter (`src/lib/llm.ts`: `chat({task, messages, schema, maxTokens})`). The adapter reads the task class's route from D1 `model_routes`, calls `AI_BASE_URL`, validates output, escalates one step on failure, and logs to `llm_calls`. Never import a vendor SDK outside the adapter.

**Gateways (set by `AI_BASE_URL`):**
- Cloudflare AI Gateway (default) — one endpoint for Workers AI, OpenAI, Google AI Studio/Vertex (Gemini), xAI (Grok), Anthropic, Groq, Mistral, DeepSeek, Cerebras, etc., `provider/model` names, caching, logs, spend caps. Docs: https://developers.cloudflare.com/ai-gateway/chat-completion/ (the compat endpoint is deprecated for single-model calls; use a gateway dynamic route or the provider REST path via the gateway).
- OmniRoute (alternate) — the owner's existing least-cost router.

Model IDs live in config, never in code. Classes below are defaults; the owner changes them on /settings/models.

| Task class | Default chain, cheapest first | Escalate one step when |
| --- | --- | --- |
| classify (tag, score, dedupe) | rules + keywords (no model) → Workers AI small open model → Gemini Flash-Lite class | invalid JSON or confidence < 0.6 |
| extract (PDF → JSON) | deterministic parser for votes/$ → Gemini Flash / GPT mini / Grok fast class → Claude Haiku class | schema validation fails |
| summarize (items) | Workers AI open model → Gemini Flash / GPT mini class; 10–20 items per call | citation check fails |
| synthesize (daily brief, weekly) | Gemini Flash / GPT mini class; optional quality tier (Gemini Pro / GPT / Grok / Claude Sonnet class) weekly only | eval below threshold |
| voice / ask | fastest cheap model: Workers AI or Groq/Cerebras-hosted open model → Gemini Flash class | > 2 s or ungrounded |
| embed | Workers AI embedding model (fixed) | — |
| speech | Workers AI Flux STT + Aura TTS | — |

**Usage minimization (required):**
1. Unchanged content (same hash) never reaches a model.
2. Rules before models; only items scoring in the ambiguous 30–70 band go to a model.
3. Batch 10–20 items per summarize call.
4. Hard `max_tokens`: classify 60, item summary 120, daily brief 600, weekly 1,200.
5. Gateway caching; identical PDFs never re-processed.
6. Workers AI first for volume work.
7. Validate every output (JSON schema + citation check); escalate at most once.
8. Budgets: daily cap $0.50, weekly $1 (editable). On hit: finish with rules-only cards + text-only brief, report to Mission Control.
9. Monthly eval: 20 past items with known-good outputs run against candidate models; each class keeps the cheapest model that passes.

**/settings/models page (admin):** per task class choose primary + fallbacks from connected providers, max tokens, daily cap; show 30-day calls, cost, failure rate, latency per model; "Run eval" button. Tables: `model_routes` (task, chain JSON, max_tokens, daily_cap_usd), `llm_calls` (task, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, at).

**Keys (all optional):** OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY — stored in AI Gateway or as Worker secrets. With zero third-party keys the app must still run on Workers AI alone.

**Scoring (0–100):** Norfolk specificity 0–30 · target-industry fit 0–25 · materiality ($, jobs, sq ft, a vote) 0–25 · timeliness 0–20 · ± memory weights (pinned +10, dismissed −10, capped).

**Grounding rules (non-negotiable):**
1. No summary without a stored source chunk; the model sees only retrieved text.
2. Every bullet carries `[n]` → URL + page/section + retrieved date.
3. Numbers copied from sources; comparisons computed in code.
4. Conflicting sources → show both.
5. Short paraphrased summaries; no long verbatim news passages.
6. Neutral language.

## Memory

Memory lets the command center tell a story over time.

| Layer | Remembers | Used for | Stored in |
| --- | --- | --- | --- |
| Entity memory | Companies, properties, projects, programs, public bodies, each with a dated mention timeline | "3rd mention this month" + mini timeline on cards | D1 `entities`, `entity_events` |
| Story threads | Multi-day narratives with status emerging/active/resolved | Brief says "Update on…" instead of repeating background | D1 `threads`, `thread_items` |
| Briefing memory | What each brief already said | No repeats | D1 `briefs`, `mentions` |
| Owner memory | Watch list, pinned/dismissed signals, most-opened tags, questions asked | Score weights; "For you" sort | D1 `prefs`, `feedback` |
| Conversation memory | Voice/Ask session (short); "remember this" notes (long) | Follow-ups; notes resurface in briefs | Durable Object; D1 `notes` + Vectorize `memory` namespace |
| Baselines | Rolling 4/12/52-week metric and volume values | "Above normal" flags, deltas | D1 `metrics` views |

**Writing memory:** after each daily run, match new items to entities/threads (name + address + embedding similarity); open a thread when ≥ 2 related items appear within 14 days; close threads idle 60 days.

**/memory page:** list entities, threads, watch list, notes with Edit, Merge, Forget (Forget deletes the record and anything derived only from it). Voice: "Watch the Greyhound site," "Stop showing me retail closures," "Forget that note."

**Limits:** tracks organizations, places, projects, public bodies, and public officials only in published roles; never profiles private individuals. Memory is never cited as a source.

**Mission Control link:** the weekly roll-up writes a one-paragraph "Norfolk EDA" summary to Mission Control's Brain view.

## Voice

1. **Listen (pre-rendered):** brief and roll-up MP3s in R2; ▶ Listen with chapter marks per bullet.
2. **Talk back (live):** mic opens a session on Cloudflare Agents SDK + `@cloudflare/voice` (`withVoice` in a Durable Object): Workers AI Flux STT → retrieval + the voice task class (fastest cheap model, any provider) → Workers AI TTS (Deepgram Aura) over WebSocket, with interruption handling. Docs: https://developers.cloudflare.com/agents/examples/voice-agent/
   - Max 3 spoken sentences, then "I've put the sources on screen"; transcript drawer shows citations.
   - End of turn: Flux auto-detect by default; optional "XX" code-word mode.
   - Read-only; "I don't have that in today's sources" instead of guessing; rate-limited; auto-close after 3 min silence.
   - Must handle: "What did the EDA approve at its last meeting?", "Any new downtown properties over 10,000 sq ft this week?", "Next grant deadline that fits the port?", "What changed since Friday?", "Why does the Beige Book matter for Norfolk?"

## Social story wall

Posts are shown as **story threads** linked to the signal or goal they illustrate.

| Platform | Method |
| --- | --- |
| YouTube / Shorts | YouTube Data API (auto) |
| Instagram, Facebook | Meta oEmbed by URL (suggested daily, owner approves) |
| LinkedIn, X, TikTok | Official embed by URL (manual / bookmarklet) |
| Local TV news video | RSS (auto) |

Accounts to watch (confirm handles): Norfolk Development, City of Norfolk, Downtown Norfolk Council, Norfolk Innovation Corridor, Port of Virginia, Hampton Roads Alliance, ODU/NSU innovation centers, Visit Norfolk, NFK Currents.

AI suggests matching posts with one-line captions, groups weekly story arcs, and drafts the owner's 30–45 s recap script and LinkedIn post for approval. Nothing posts automatically.

## Data model

Isolated stack: D1 `eda_cc`, R2 `eda-cc-raw`, KV `EDA_CACHE`, Vectorize `eda-cc-index` (+ `memory` namespace).

| Table | Key fields |
| --- | --- |
| `sources` | id, name, url, tier, method, cadence, tags, keyword_filter, active, deleted_at, last_ok, last_new, fail_count |
| `source_changes` | source_id, action, before, after, at |
| `snapshots` | source_id, fetched_at, hash, r2_key |
| `items` | id, source_id, url, title, published_at, type, tags, score, summary, why, raw_excerpt |
| `citations` | item_id, url, locator, retrieved_at |
| `signals` | item_id, rule_hit, score, status (new/seen/pinned/dismissed) |
| `meetings` | body, date, agenda_url, minutes_url, actions JSON |
| `properties` | address, lat, lng, sq_ft, price, zoning, status, source_id, first_seen, last_seen |
| `metrics` | series, period, value, source_id |
| `grants` | program, agency, deadline, amount, fit_score, url |
| `goals` | plan, goal_text |
| `posts` | platform, url, embed_html, author, posted_at, linked_item_id, approved |
| `briefs` | kind, period, body_md, audio_r2_key |
| `runs` | kind, started_at, finished_at, ok, failed_sources, items_new, cost_usd |
| `entities` / `entity_events` | type, name, aliases, address · entity_id, item_id, at |
| `threads` / `thread_items` | title, status, opened_at, last_at · thread_id, item_id |
| `mentions` | brief_id, entity_id/thread_id |
| `prefs` / `feedback` / `notes` | watch list, weights · signal_id, action · text, source_ids |
| `model_routes` | task, chain JSON, max_tokens, daily_cap_usd |
| `llm_calls` | task, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, at |

**API:** `GET /api/brief/today`, `/api/signals?tag=&min=`, `/api/meetings`, `/api/properties.geojson`, `/api/metrics/:series`, `/api/weekly/:week`, `POST /api/ask`, `WS /voice`; Source Manager routes above; `GET/PATCH/DELETE /api/memory/{entities,threads,notes,prefs}`. Admin routes behind Cloudflare Access.

## Skills (in `.claude/skills/`)

| Skill | Job |
| --- | --- |
| `eda-cc-build` | Scaffold, migrate, deploy everything to edascout.ktsapps.com |
| `eda-daily-brief` | Daily pipeline logic + Today's Brief |
| `eda-weekly-rollup` | Weekly synthesis + audio script |
| `eda-meeting-parser` | Agenda/minutes PDFs → structured actions |
| `eda-source-scout` | Source add/test/health; backs Source Manager preview + suggestions |
| `eda-story-wall` | Social curation + recap/LinkedIn drafts |
| `eda-voice-guide` | Voice/Ask persona and rules |

## Build plan

1. **Phase 1 — Core loop (ship today):** Tier 1 sources, D1 schema (all tables), daily Workflow, meeting parser, Signal Board, EDA Watch, City Hall Feed, Today's Brief (text), Source Manager, vendor-neutral LLM adapter + model routes (Models page can follow in Phase 2), Norfolk palette, dividers, core motion. Deployed to edascout.ktsapps.com behind Cloudflare Access.
2. **Phase 2 — Context + rhythm:** Property Map, Grants Radar, Regional Pulse, Strategy Tracker, weekly roll-up, ▶ Listen audio.
3. **Phase 3 — Conversation:** Memory + /memory page, Ask (text), live voice.
4. **Phase 4 — Story + share:** Story Wall, recap/LinkedIn drafts, share pages, Mission Control run cards.

**Running cost (approx.):** Workers Paid base ($5/mo, already on), storage near included tiers, third-party model APIs ~$3–15/mo with Workers AI and Flash/mini-class models doing the volume, Workers AI speech a few dollars. Total ~$10–25/mo; daily/weekly caps bound spend.

**Build vs. run:** the running app is vendor-neutral. Mission Control's build agents use Claude Code; set Mission Control Model routing to "light" or "all" so subagents go through OmniRoute, and keep the first launch to Phase 1.

## Open decisions (defaults used until changed)
- Subdomain: **edascout.ktsapps.com**
- Visibility: **private** (Cloudflare Access) at launch
- Brief delivery: site only (email/SMS later)
- Meta oEmbed: manual URLs until a Meta app exists
- Voice end-of-turn: Flux auto-detect, "XX" optional
- Named watch items to seed: MacArthur Center, Greyhound Station site, Innovation Corridor
