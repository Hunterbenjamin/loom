WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY repo_id
           ORDER BY json_extract(data, '$.createdAt'), id
         ) AS number
  FROM tasks
  WHERE json_type(data, '$.number') IS NULL
)
UPDATE tasks
SET data = json_set(
  data,
  '$.number', (SELECT number FROM numbered WHERE numbered.id = tasks.id),
  '$.name', json('null')
)
WHERE id IN (SELECT id FROM numbered);

CREATE UNIQUE INDEX tasks_repo_number
ON tasks(repo_id, json_extract(data, '$.number'));
