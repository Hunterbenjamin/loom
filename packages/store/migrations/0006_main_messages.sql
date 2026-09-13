-- Operator tables remain retired and untouched. Main owns new message notes and receipts.
CREATE TABLE main_message_notes (id TEXT PRIMARY KEY, task_id TEXT, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX main_message_notes_task ON main_message_notes(task_id);
CREATE TABLE main_message_receipts (key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
