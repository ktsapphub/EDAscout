-- Privacy-light usage counter: one row per (day, anonymous browser id hash). No IPs, no raw ids.
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,
  vid TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, vid)
);
