CREATE TABLE research_comments (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  entry_id TEXT NOT NULL REFERENCES research(id),
  value TEXT NOT NULL
);
CREATE INDEX research_comments_entry ON research_comments(entry_id, sequence);
