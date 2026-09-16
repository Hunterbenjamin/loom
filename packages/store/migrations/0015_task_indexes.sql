-- Loading a task's state reads every task-keyed table by task_id. Only artifacts and findings
-- had an index that starts with it; the rest were full scans, once per task per load.
CREATE INDEX outbox_task ON outbox(task_id);
CREATE INDEX inbox_task ON inbox(task_id);
CREATE INDEX transitions_task ON transitions(task_id);
CREATE INDEX messages_task ON messages(task_id);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX questions_task ON questions(task_id);
CREATE INDEX approvals_task ON approvals(task_id);
