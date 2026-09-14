CREATE TABLE lead_messages (
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','sent','delivered','failed','refused')),
  reason TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  PRIMARY KEY(repo_id, id)
);
CREATE INDEX lead_messages_repo_created ON lead_messages(repo_id, created_at DESC);
