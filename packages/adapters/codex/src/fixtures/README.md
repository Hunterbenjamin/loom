# Fixture provenance

`recorded-0.154.0.json` contains trimmed output captured on 2026-09-12 from
an isolated **codex-cli 0.154.0** app-server during this package's real smoke test:

- The `remoteControl/status/changed` notification retains its real envelope timestamp;
  machine name and installation/environment identifiers were removed from `params`.
- Metadata is the zod-validated projection of `thread/read` with `includeTurns: false`
  for a freshly allocated thread. Its thread ID and temporary cwd were replaced.
- `unloaded` is the exact error from `thread/read` for the deliberately absent fixture
  UUID (both include-turns modes produced it); `missing` is the native resume error
  for that same UUID. No live external session was queried or resumed.

`traffic.json` is a **synthetic replay fixture**, reconstructed from spike 01's
published protocol examples and the generated 0.154.0 types. It supplies an active
turn, normalized input, a pending command approval and exhausted quota windows for
offline coverage. It is not a claim that quota exhaustion or the wrong-turn error
wording was measured against a real account. Session/item IDs, command paths and
input text are test values.

`fake-cli.mjs` is a Node-only fake executable for process ownership tests. It reports
the pinned version and handles initialization on its own temporary socket; it
cannot launch a model or a coding agent.
