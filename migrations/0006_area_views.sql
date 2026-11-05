-- Page views per area (Norfolk / Hampton Roads / Virginia) per day, so site usage can be shown combined and split by area.
CREATE TABLE IF NOT EXISTS area_views (
  day TEXT NOT NULL,
  geo TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, geo)
);
