-- EDAScout schema. Phase 1 uses the core tables; memory tables are created now so later phases need no rework.

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  tier INTEGER NOT NULL DEFAULT 1,
  method TEXT NOT NULL DEFAULT 'html',          -- html | rss | pdf
  cadence TEXT NOT NULL DEFAULT 'daily',        -- daily | weekly | monthly
  tags TEXT NOT NULL DEFAULT '',                -- comma separated
  kind TEXT NOT NULL DEFAULT 'news',            -- news | meetings | properties | grants | context
  keyword_filter TEXT,                          -- only keep items mentioning one of these (comma separated)
  link_pattern TEXT,                            -- optional regex links must match
  origin TEXT NOT NULL DEFAULT 'recommended',   -- yours | recommended | added
  active INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  etag TEXT,
  last_modified TEXT,
  last_hash TEXT,
  last_fetched TEXT,
  last_ok TEXT,
  last_new TEXT,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER, action TEXT, before TEXT, after TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seen_links (
  source_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, url)
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL DEFAULT 'news',
  tags TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  rule_hits TEXT NOT NULL DEFAULT '',
  summary TEXT,
  why TEXT,
  raw_excerpt TEXT,
  summarized INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, url)
);
CREATE INDEX IF NOT EXISTS items_found ON items(found_at);
CREATE INDEX IF NOT EXISTS items_score ON items(score);

CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL, url TEXT NOT NULL, locator TEXT,
  retrieved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signals (
  item_id INTEGER PRIMARY KEY,
  rule_hit TEXT, score INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',           -- new | seen | pinned | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  body TEXT NOT NULL,                           -- EDA | City Council | Planning Commission | NRHA | Other
  doc_kind TEXT NOT NULL DEFAULT 'agenda',      -- agenda | minutes
  meeting_date TEXT,
  doc_url TEXT NOT NULL UNIQUE,
  actions TEXT,                                 -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                           -- daily | weekly
  period TEXT NOT NULL,                         -- YYYY-MM-DD or YYYY-Www
  body TEXT NOT NULL,                           -- JSON {bullets:[{text, items:[ids]}], watch}
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, period)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'daily',
  trigger TEXT NOT NULL DEFAULT 'cron',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok INTEGER,
  sources_ok INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS model_routes (
  task TEXT PRIMARY KEY,                        -- classify | summarize | extract | synthesize | voice
  chain TEXT NOT NULL,                          -- JSON array of {provider, model, base_url?, key?}
  max_tokens INTEGER NOT NULL DEFAULT 400,
  daily_cap_calls INTEGER NOT NULL DEFAULT 60,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT, provider TEXT, model TEXT,
  tokens_in INTEGER, tokens_out INTEGER,
  latency_ms INTEGER, ok INTEGER, error TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls(at);

-- Memory (Phase 3)
CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, name TEXT UNIQUE, aliases TEXT, address TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS entity_events (entity_id INTEGER, item_id INTEGER, at TEXT DEFAULT (datetime('now')), PRIMARY KEY (entity_id, item_id));
CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT DEFAULT 'emerging', opened_at TEXT DEFAULT (datetime('now')), last_at TEXT);
CREATE TABLE IF NOT EXISTS thread_items (thread_id INTEGER, item_id INTEGER, PRIMARY KEY (thread_id, item_id));
CREATE TABLE IF NOT EXISTS mentions (brief_id INTEGER, item_id INTEGER, PRIMARY KEY (brief_id, item_id));
CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, action TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, item_ids TEXT, at TEXT DEFAULT (datetime('now')));
