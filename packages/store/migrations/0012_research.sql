CREATE TABLE research (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  started_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX research_history ON research(archived_at, started_at DESC, id DESC);
