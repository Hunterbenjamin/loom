-- Additive Phase 1b context. New installations write all fields explicitly.
CREATE TABLE task_context (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), data TEXT NOT NULL CHECK(json_valid(data)),
  artifact_versions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(artifact_versions))
);
-- Version 1 did not store Phase 1b context. Only initial tasks can be upgraded losslessly.
-- Do not invent absent plan/review/budget history for an existing non-initial task.
INSERT INTO task_context(task_id, data)
SELECT id, json_object(
  'plan', NULL, 'review', NULL, 'desiredRun', NULL, 'progress', NULL,
  'activeElapsedMs', 0, 'budgetObservedAt', json_extract(data, '$.createdAt')
) FROM tasks WHERE stage = 'backlog' AND version = 0;
