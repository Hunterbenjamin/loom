CREATE TABLE operator_events (
 id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), processed_at TEXT
);
CREATE TABLE operator_notes (
 id TEXT PRIMARY KEY, task_id TEXT, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX operator_notes_task ON operator_notes(task_id);
CREATE TABLE operator_ledger (key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE operator_filings (task_id TEXT PRIMARY KEY REFERENCES tasks(id), signature TEXT NOT NULL, filed_at TEXT NOT NULL);
CREATE INDEX operator_signature ON operator_filings(signature);
