# Phase 2: `packages/mcp`

**Agent:** codex · **Branch:** `feat/mcp` · **PR title:** "Phase 2: Loom MCP server". Read
[`phase-2-common.md`](phase-2-common.md) first. This package lives at `packages/mcp`, not under
`adapters/`.

## Build

The MCP server agents call, per `docs/design/core.md` §7, using `@modelcontextprotocol/sdk`.

- **Zod schemas** for every tool's input and output in `packages/core/src/mcp.ts`, with a type-level
  test that each schema's inferred type equals the core type (decision 19).
- **Identity:** each run gets its own token, passed in the run's MCP config. The token maps to a run;
  no tool takes a task or run ID. Unknown or ended tokens return `unknown_run` or `stale_run`.
- **Flow:** validate → resolve the token → persist as an `mcp` input (assigning finding and question
  IDs, and building each review finding's full `FindingAnchor` from the reviewed blobs via a
  caller-supplied function) → run one reconcile pass → answer with that input's disposition, using
  the `McpError` codes and one `details` line per failed guard. `get_task_context` is read-only and
  never becomes an input.
- The server takes two things from its host: a `submit(input) → Promise<InputDisposition>` and a
  `context(runId) → GetTaskContextOutput`. Define those as an interface; the coordinator implements
  them in Phase 3. Provide an in-memory implementation for tests.
- Two transports: stdio (for `claude --mcp-config` and Codex's MCP config) and a local HTTP
  endpoint; both with the token.

## Tests

Unit tests drive the server through the SDK client against the in-memory host: every tool's happy
path, each `McpErrorCode`, a stale token, and a `submit_review` whose findings get anchors. No real
agent. An opt-in real test registers the server with one headless Claude session on `--model haiku`
and calls `get_task_context`.

## Out of scope

The reconcile loop itself, persistence, and the coordinator.
