-- Additive: fill missing fields once; existing values and task versions/stages stay intact.
-- #203 must have imported repository settings with the instance's startup configuration.
CREATE TEMP TABLE current_rows_guard (
  ready INTEGER CONSTRAINT run_a_203_build_to_import_repository_settings CHECK (ready = 1)
);
INSERT INTO current_rows_guard
SELECT NOT EXISTS (
  SELECT 1 FROM repos
  WHERE json_type(data, '$.baseBranch') IS NOT NULL
     OR json_type(data, '$.defaultProviders') IS NOT NULL
     OR json_type(data, '$.serialTests') IS NOT NULL
);
DROP TABLE current_rows_guard;

CREATE TEMP TABLE current_rows_clock (at TEXT NOT NULL);
INSERT INTO current_rows_clock VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE runs SET data = json_set(data, '$.access', 'full')
WHERE json_extract(data, '$.access') IS NULL;
UPDATE runs SET data = json_set(data, '$.idleSince',
  CASE WHEN status = 'idle' THEN coalesce(json_extract(data, '$.lastActivityAt'),
    json_extract(data, '$.launchedAt'), (SELECT at FROM current_rows_clock)) ELSE NULL END)
WHERE json_type(data, '$.idleSince') IS NULL
   OR (status = 'idle' AND json_extract(data, '$.idleSince') IS NULL);

UPDATE messages SET data = json_set(data, '$.when', 'now')
WHERE json_extract(data, '$.when') IS NULL;
-- Pending delivery gets a full timeout window, as its first reconciliation used to provide.
UPDATE messages SET data = json_set(data, '$.pendingSince',
  CASE WHEN json_extract(data, '$.status') = 'pending' THEN (SELECT at FROM current_rows_clock)
    ELSE coalesce(json_extract(data, '$.sentAt'), (SELECT at FROM current_rows_clock)) END)
WHERE json_extract(data, '$.pendingSince') IS NULL;
UPDATE messages SET data = json_set(data, '$.status', 'failed', '$.deliveryAttention', json('false'))
WHERE run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL)
  AND (json_extract(data, '$.status') = 'sent'
    OR (json_extract(data, '$.status') = 'pending' AND json_extract(data, '$.attempts') > 0));

UPDATE approvals SET data = json_set(data, '$.approvedBy', 'human')
WHERE json_extract(data, '$.kind') = 'merge' AND json_extract(data, '$.approvedBy') IS NULL;
UPDATE tasks SET data = json_set(data, '$.attention.reasonSince', json('{}'))
WHERE json_extract(data, '$.attention.reasonSince') IS NULL;
UPDATE tasks SET data = json_set(data, '$.attention.reasonSince', json_patch(
  json_extract(data, '$.attention.reasonSince'),
  (SELECT json_group_object(reason.value, json_extract(tasks.data, '$.attention.since'))
   FROM json_each(tasks.data, '$.attention.reasons') reason
   WHERE json_extract(tasks.data, '$.attention.reasonSince.' || reason.value) IS NULL)))
WHERE EXISTS (
  SELECT 1 FROM json_each(tasks.data, '$.attention.reasons') reason
  WHERE json_extract(tasks.data, '$.attention.reasonSince.' || reason.value) IS NULL
);
UPDATE outbox SET data = json_set(data, '$.action.access', 'full')
WHERE json_extract(data, '$.action.kind') = 'start_run'
  AND json_extract(data, '$.action.access') IS NULL;
DROP TABLE current_rows_clock;
