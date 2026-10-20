-- v2: geography scope, trend metrics (FRED), money tracker, federal awards, reference-only sources.

ALTER TABLE sources ADD COLUMN geo TEXT NOT NULL DEFAULT 'norfolk';   -- norfolk | region | state | national

CREATE TABLE IF NOT EXISTS metrics (
  series TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series, date)
);

CREATE TABLE IF NOT EXISTS money (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'mention',     -- investment | grant | approval | budget | housing | mention
  found_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, amount)
);
CREATE INDEX IF NOT EXISTS money_found ON money(found_at);

CREATE TABLE IF NOT EXISTS awards (
  id TEXT PRIMARY KEY,
  recipient TEXT, amount REAL, agency TEXT, description TEXT,
  start_date TEXT, url TEXT,
  found_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Geography for the scope selector.
UPDATE sources SET geo = 'region' WHERE id IN (19, 20, 21, 22, 26, 27, 28, 29);
UPDATE sources SET geo = 'state' WHERE id IN (23, 24, 25, 31, 34);
UPDATE sources SET geo = 'national' WHERE id IN (8, 15, 30, 32, 33, 35, 36, 37, 38);

-- Sites whose robots.txt asks crawlers to stay out: keep them as linked references, never fetched.
UPDATE sources SET kind = 'reference', fail_count = 0, last_error = NULL WHERE id IN (24, 25, 34, 36);
-- Very large report PDFs: link-only reference.
UPDATE sources SET kind = 'reference', fail_count = 0, last_error = NULL WHERE id = 20;

-- More reliable feeds.
INSERT OR IGNORE INTO sources (name, url, tier, method, cadence, tags, kind, keyword_filter, origin, active, geo) VALUES
('Google News: Norfolk economic development', 'https://news.google.com/rss/search?q=Norfolk+Virginia+%22economic+development%22+OR+%22development+authority%22&hl=en-US&gl=US&ceid=US:en', 1, 'rss', 'daily', 'News', 'news', NULL, 'recommended', 1, 'norfolk'),
('Google News: Norfolk housing & real estate', 'https://news.google.com/rss/search?q=Norfolk+Virginia+housing+OR+%22real+estate%22+OR+apartments&hl=en-US&gl=US&ceid=US:en', 1, 'rss', 'daily', 'Housing,Real Estate', 'news', NULL, 'recommended', 1, 'norfolk'),
('Google News: Hampton Roads business', 'https://news.google.com/rss/search?q=%22Hampton+Roads%22+business+OR+jobs+OR+port&hl=en-US&gl=US&ceid=US:en', 2, 'rss', 'daily', 'Regional', 'news', NULL, 'recommended', 1, 'region'),
('Google News: Virginia economic development', 'https://news.google.com/rss/search?q=Virginia+%22economic+development%22+jobs+investment&hl=en-US&gl=US&ceid=US:en', 2, 'rss', 'daily', 'Statewide', 'news', NULL, 'recommended', 1, 'state');
