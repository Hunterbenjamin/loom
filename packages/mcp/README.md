# @loom/mcp

Validated agent tools over SDK stdio or loopback Streamable HTTP. The package supplies factories,
not a coordinator or durable state. Core owns stage guards; the coordinator supplies the host.

## Host integration

[server.ts](src/server.ts) defines `McpHost`, `McpServerOptions`, token resolution and anchor
construction. [transports.ts](src/transports.ts) exports `serveHttp` and `serveStdio`;
[coordinator/mcp-host.ts](../../apps/coordinator/src/mcp-host.ts) is the production integration.

Task tools are `get_task_context`, `submit_plan`, `report_progress`, `ask_human`,
`submit_for_review`, `submit_review` and `resolve_finding`. [schemas.ts](src/schemas.ts) owns
validation; [core/mcp.ts](../core/src/mcp.ts) owns their pure types. Arguments carry no task/run IDs:
identity comes from the private token and is rechecked against current run state on every call.
Unknown tokens return `unknown_run`; ended/superseded tokens return `stale_run`.

The host persists enriched inputs, reconciles against required observations and commits disposition
before replying. `get_task_context` is read-only, with [full/changes semantics](../../docs/design/agents.md#context-and-fix-rounds).
`ask_human` records a question and returns without waiting; answers arrive through normal messaging.

Review anchors come from immutable reviewed Git blobs, not current working files. Paths, line
ranges and identities are validated before submission; failed enrichment submits nothing. Input,
question and finding IDs are assigned at the boundary.

Replies include the typed result in `structuredContent` and JSON text. Rejections set `isError` and
retain actionable details for `invalid_input`, `unknown_run`, `stale_run`, `wrong_stage` and
`guard_failed`. Output schemas validate host replies and correlate the input/tool identity.

## Transports and registration

HTTP binds to `127.0.0.1`, serves `/mcp`, checks Host/Origin and reads the bearer token on every
request. MCP session IDs do not confer identity. Stdio reserves stdout for protocol frames; host
diagnostics go to stderr. Closing a transport does not undo committed inputs.

The coordinator writes private run configuration outside the repository and supplies `LOOM_MCP_TOKEN`
in the child environment. It never edits global provider config. Production registration lives in
[coordinator launch](../../apps/coordinator/src/launch.ts) and provider adapters:

- Claude interactive uses separate hook settings and `--mcp-config`; headless SDK receives
  `mcpServers` natively. See [Claude settings](../adapters/claude/src/settings.ts).
- Codex uses thread-specific registration against the issue's private app-server; see
  [Codex adapter](../adapters/codex/README.md).

## Main identity

`leadHost` and the internal `kind: "lead"` identity select a separate tool set defined in
[lead.ts](src/lead.ts). Run identities cannot call Main tools, and Main cannot submit role results.
Its repository-scoped operations and notes/messages are described in
[agent layers](../../docs/design/agents.md#main). Main task mutations return the same guarded command
outcome as CLI/window commands.

## Verification

Colocated tests use SDK clients, synthetic blobs and [InMemoryHost](src/memory.ts). They cover
identity isolation, expired tokens, anchor validation, correlated dispositions and transport framing.
Schema type-equality assertions run under typecheck. Real registration probes in `src/real.test.ts`
are opt-in with `LOOM_REAL_PROVIDERS=1`; see [repository checks](../../AGENTS.md#checks).

## Shared shapes

Core owns closed value lists and entity types; protocol owns entity zod schemas. MCP derives
plans, anchors, stages, finding statuses, severities, roles, sides and test results from protocol.
Agent-only validation stays here: nonblank goals, string steps, repository-relative review
locations and 64-hex anchor hashes. Tool input/output JSON schemas remain unchanged.
