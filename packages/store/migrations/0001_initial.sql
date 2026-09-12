-- Additive. Entity JSON preserves optional contract fields; generated columns index owned facts.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '0'), ('capacity_version', '0');
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, breaking INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE repos (
  id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
  root TEXT GENERATED ALWAYS AS (json_extract(data, '$.root')) STORED UNIQUE
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  version INTEGER GENERATED ALWAYS AS (json_extract(data, '$.version')) STORED NOT NULL,
  stage TEXT GENERATED ALWAYS AS (json_extract(data, '$.stage')) STORED NOT NULL,
  worktree_path TEXT GENERATED ALWAYS AS (json_extract(data, '$.worktreePath')) STORED UNIQUE,
  needs_attention INTEGER GENERATED ALWAYS AS (json_array_length(data, '$.attention.reasons') > 0) STORED
);
CREATE INDEX tasks_stage ON tasks(stage);
CREATE INDEX tasks_attention ON tasks(needs_attention) WHERE needs_attention = 1;
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id), blocked_by TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(task_id, blocked_by)
);
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  port_slot INTEGER GENERATED ALWAYS AS (json_extract(data, '$.portSlot')) STORED UNIQUE
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  provider TEXT GENERATED ALWAYS AS (json_extract(data, '$.provider')) STORED NOT NULL,
  session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) STORED NOT NULL,
  ended_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.endedAt')) STORED,
  UNIQUE(provider, session_id)
);
CREATE INDEX runs_live ON runs(task_id, provider, status) WHERE ended_at IS NULL;
CREATE TABLE messages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  run_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.runId')) STORED REFERENCES runs(id)
);
CREATE TABLE questions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data)),
  source TEXT GENERATED ALWAYS AS (json_extract(data, '$.source')) STORED,
  external_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.externalId')) STORED,
  UNIQUE(task_id, source, external_id)
);
CREATE TABLE finding_locations (
  finding_id TEXT NOT NULL REFERENCES findings(id), version INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(finding_id, version)
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  content TEXT NOT NULL CHECK(json_valid(content)), UNIQUE(task_id, kind, version)
);
CREATE TABLE transitions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id), received_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), consumed_at TEXT,
  disposition TEXT CHECK(disposition IS NULL OR json_valid(disposition))
);
CREATE INDEX inbox_pending ON inbox(task_id, received_at, seq) WHERE consumed_at IS NULL;
CREATE TABLE outbox (
  key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) STORED NOT NULL,
  started_at TEXT, executor_finished_at TEXT, result_input_id TEXT REFERENCES inbox(id),
  claim_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending ON outbox(status);
CREATE TABLE claude_hooks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event TEXT NOT NULL,
  prompt_id TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX claude_hooks_session ON claude_hooks(session_id, seq);
CREATE INDEX claude_hooks_age ON claude_hooks(received_at);
