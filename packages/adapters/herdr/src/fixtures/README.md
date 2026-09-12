# Recorded Herdr responses

Recorded on 2026-09-12 with Herdr 0.9.0, protocol 22, from the private
`loom-test-herdr` server. Requests were newline-delimited JSON sent directly to
that session's Unix socket, never to the default session. The server used a
private config and scrubbed parent environment. No terminal text was read.

Sanitization replaces the temporary work directory with `/fixture/work` and the
newly allocated Claude UUID with `00000000-0000-4000-8000-000000000001`.
Request IDs are `record`. Terminal titles are omitted. No credentials, email
addresses, prompts from real work, or provider transcripts are included.

- `workspace-created.json`: `workspace.create` for an existing temporary directory.
- `startup-pending.json`: `agent.start fixture-claude`, native args
  `--model haiku --session-id <allocated UUID>`, through the scrubbing function.
- `startup-blocked.json`: fresh `agent.get` on that pane after startup; the
  folder-trust dialog was not answered and no provider prompt was sent.
- `prompt-blocked.json`: `agent.prompt` on that blocked startup, refused by Herdr
  before writing any text.
- `agent-session.json`: `agent.get` after `pane.report_agent_session` with the
  same preallocated Claude ID and source `herdr:claude`.
- `report-session.json`: that report's `ok` response; the report was also repeated
  and independently read back in the opt-in smoke test.
- `process-shell.json`: `pane.process_info` from a fixture-owned Zsh shell.
- `ok.json`: `pane.send_input` acknowledgement for the pane-local launcher setup.
- `subscribe.json`: `events.subscribe` acknowledgement.
- `event.json`: `workspace.created` subscription notification after creating an
  additional private workspace. The envelope uses `workspace_created`.
- `agent-list.json`: `agent.list` in the private session. It includes the blocked
  real Claude startup plus two synthetic occupants registered with
  `pane.report_agent`/`pane.report_agent_session` for protocol experiments. Their
  screen statuses are not evidence of a real provider's state.

The fake server rewrites only request IDs and fixture cwd during replay. Tests
also explicitly construct adverse states: successful prompt submission, ready
startup, missing agents, resumed Codex process argv, absent processes, timeouts,
malformed JSON, and connection loss. These are **injected test cases**, not new
live-provider findings. In particular, the resumed Codex readiness-timeout behavior
comes from spike 05; this adapter did not create a live Codex thread to remeasure it.

To repeat the live contract checks from a clean session, run:

```
LOOM_REAL_PROVIDERS=1 pnpm test packages/adapters/herdr/src/real.test.ts
```

The smoke test owns and removes only its newly created named session. It refuses
an existing `loom-test-herdr` directory rather than reusing or stopping it.
