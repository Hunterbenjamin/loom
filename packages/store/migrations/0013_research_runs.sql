-- breaking
-- Headless agent entries cannot resume as interactive sessions. Main documents survive.
DELETE FROM research WHERE json_extract(value, '$.origin') = 'agent';
UPDATE research SET value = json_set(value, '$.directory', NULL, '$.pane', NULL, '$.observedStatus', 'unknown');
