-- Durable instance/repository settings and append-only mutation audit.
CREATE TABLE settings (
  scope TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 0),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, repo_id),
  CHECK((scope = 'global' AND repo_id = '') OR (scope = 'repository' AND repo_id <> ''))
);

CREATE TABLE settings_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  repo_id TEXT,
  actor TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  settings_version INTEGER NOT NULL
);

CREATE INDEX settings_audit_recent ON settings_audit(changed_at DESC, id DESC);
