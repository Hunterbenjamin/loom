# Recorded fixtures

- `agents.json` — `claude agents --json` from Claude Code 2.1.269 on macOS. The two interactive
  entries are real, with the home directory rewritten to `/Users/example`; `status` on the second
  was recorded as `busy` and is set to `waiting` here so the fixture covers both. The background
  entry is spike 02's (§7), which is the only recording of a `--bg` session's extra `id` and
  `state` fields.
- `payload-samples.json` — one sample of every hook event spike 02 observed, copied verbatim from
  `spikes/02-claude-hooks/evidence/payload-samples.json` (Claude Code 2.1.268).
