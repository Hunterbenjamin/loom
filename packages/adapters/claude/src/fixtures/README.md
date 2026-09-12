# Recorded fixtures

- `agents.json` — `claude agents --json` from Claude Code 2.1.269 on macOS, sanitized by rewriting
  session IDs and working directories. The background entry has the observed `state` field and no
  `status`; the interactive entry has `status` and no `state`.
- `payload-samples.json` — one sample of every hook event spike 02 observed, copied verbatim from
  `spikes/02-claude-hooks/evidence/payload-samples.json` (Claude Code 2.1.268).
