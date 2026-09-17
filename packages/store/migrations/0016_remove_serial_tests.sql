-- Retire the unused setting in both global and repository overrides.
UPDATE settings
SET data = json_remove(data, '$.repository.serialTests')
WHERE json_type(data, '$.repository.serialTests') IS NOT NULL;
