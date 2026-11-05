-- Estimated usage for the period before full tracking (Oct 20 - Nov 5, 2026). Kept apart from measured counts
-- and shown on the site as an estimate. Owner-provided totals: 17 visitors / 320 views all time incl. measured.
CREATE TABLE IF NOT EXISTS usage_estimates (
  day TEXT PRIMARY KEY,
  visitors INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  norfolk INTEGER NOT NULL DEFAULT 0,
  region INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0
);
INSERT OR REPLACE INTO usage_estimates (day, visitors, views, norfolk, region, state) VALUES
('2026-10-20', 1, 22, 13, 4, 5),
('2026-10-21', 1, 20, 12, 4, 4),
('2026-10-22', 1, 19, 11, 4, 4),
('2026-10-23', 0, 8, 5, 2, 1),
('2026-10-24', 1, 18, 11, 3, 4),
('2026-10-25', 1, 17, 10, 3, 4),
('2026-10-26', 1, 21, 13, 4, 4),
('2026-10-27', 1, 19, 11, 4, 4),
('2026-10-28', 0, 9, 5, 2, 2),
('2026-10-29', 1, 18, 11, 3, 4),
('2026-10-30', 1, 17, 10, 3, 4),
('2026-10-31', 1, 18, 11, 3, 4),
('2026-11-01', 1, 17, 10, 3, 4),
('2026-11-02', 1, 19, 11, 4, 4),
('2026-11-03', 1, 20, 12, 4, 4),
('2026-11-04', 1, 18, 11, 3, 4),
('2026-11-05', 1, 15, 11, 3, 1);
