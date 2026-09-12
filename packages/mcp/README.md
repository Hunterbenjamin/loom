# @loom/mcp

Loom's seven agent tools over SDK stdio or loopback Streamable HTTP. Tools carry no task or run ID;
identity comes from the run's MCP config. Core validates stages and guards. The package neither
executes actions nor starts a coordinator.

## Host integration

```ts
import { serveHttp, serveStdio, type McpServerOptions } from "@loom/mcp";

const options: McpServerOptions = {
  host: {
    submit: async (input) => coordinator.persistAndReconcile(input),
    context: (runId) => coordinator.readTaskContext(runId),
  },
  resolveToken: (token) => coordinator.lookupRunToken(token),
  buildAnchor: ({ runId, reviewedSha, location }) =>
    coordinator.anchorReviewedBlob(runId, reviewedSha, location),
};

// In the coordinator process:
const http = await serveHttp(options); // http.url is http://127.0.0.1:<port>/mcp
// At shutdown: await http.close();

// Or in a host-provided stdio entrypoint:
const stdio = await serveStdio(options, process.env.LOOM_MCP_TOKEN ?? "");
// At shutdown: await stdio.close();
```

`coordinator` above denotes the Phase 3 implementation, not an API supplied here. A stdio child
needs a host bridge back to that implementation; HTTP can use the host directly. This package
exports factories rather than a standalone executable with its own durable state. Stdout is
reserved for MCP; host diagnostics belong on stderr and must exclude tokens.

The `McpHost` contract consists of `submit(input): Promise<InputDisposition>` and
`context(runId): GetTaskContextOutput | Promise<GetTaskContextOutput>`. The host must:

- Persist the supplied input ID and enriched call before reconciling. Serialize reconciliation
  per task and atomically commit state, audit rows and that input's disposition before answering.
  Retain dispositions so replaying the same persisted input cannot duplicate its effects.
- Recheck the run's liveness within the submission transaction (core already does this) and the
  read transaction for context. Context is role-filtered by the host and never enters the inbox.
- Refresh the observations required by core's guards, including git HEAD and PR state. This
  server does not read git or infer facts from terminal output.

`resolveToken` returns `null` for unknown tokens, or `{runId, active}`. It must consult current
state on every call: ended, superseded, canceled and completed runs are inactive. Create an
unguessable token per run before launch (for example, 32 random bytes), retain it securely, and
retain the inactive mapping to distinguish `stale_run` from `unknown_run`. Never derive a token
from a task/run ID or accept one in tool arguments. Empty tokens always return `unknown_run`.

`buildAnchor` reads the exact reviewed base/head blobs within the run's repository, validates the
path and line range, and returns every `FindingAnchor` field, including normalized text and hashes.
It must not read the current working file. The server checks the anchor schema and its head,
path, side, range and blob presence. Throw `McpGuardError` with one safe, actionable detail per
failed check for absent blobs/lines. The server collects failures across findings; nothing is
submitted if enrichment fails. Task-level findings receive a null anchor. IDs for inputs,
questions and findings are assigned here before submission.

All replies contain the core `McpResult<T>` in both `structuredContent` and JSON text. Rejections
set MCP `isError: true`; `invalid_input`, `unknown_run`, `stale_run`, `wrong_stage` and `guard_failed`
preserve their `details` lines. Host implementation/availability errors become generic protocol
errors rather than a fabricated guard result or a leaked raw exception. A host reply must match
both the submitted input ID and tool, and its output must pass the tool schema.

`serveHttp` binds only to `127.0.0.1` (port 0 by default), accepts requests at `/mcp`, and checks
Host/Origin headers. It is stateless: the bearer token is read on every request; MCP session IDs
never confer identity. Initialization and tool discovery expose only public schemas; calls without
a valid token return `unknown_run`. Closing a transport does not cancel or roll back a host commit.

`InMemoryHost` is a test implementation using the existing core reconciler with supplied state,
observations and a context reader. It retains an inbox and dispositions, performs one pass per
new input, and never executes the resulting actions. Its token map is for fixtures only.

## Provider registration

A run's **MCP config** carries the token. Claude's hook settings and MCP registration are separate.
Use private per-run files (mode `0600`) outside the repository for token-bearing configuration.
The coordinator supplies `LOOM_MCP_TOKEN` in the child environment; do not put a real token in
shell arguments, documentation, logs or commits.

### Claude Code, interactive

Write a separate `/absolute/run/mcp.json` and pass it with `--mcp-config`. An `mcpServers` entry
inside `--settings` is ignored by Claude Code 2.1.269. The existing Claude adapter writes the
sibling `.mcp.json` via [settings.ts](../adapters/claude/src/settings.ts).

Stdio configuration, with the placeholder replaced privately by the coordinator:

```json
{
  "mcpServers": {
    "loom": {
      "command": "node",
      "args": ["/absolute/coordinator/mcp-entry.mjs"],
      "env": { "LOOM_MCP_TOKEN": "<per-run-token>" }
    }
  }
}
```

```sh
claude --settings /absolute/run/hooks.json --mcp-config /absolute/run/mcp.json
```

For HTTP, replace the `loom` entry with:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:47802/mcp",
  "headers": { "Authorization": "Bearer <per-run-token>" }
}
```

Use the URL returned by `serveHttp`, not the example port.

### Claude, headless Agent SDK

Pass the same server entry natively to the SDK's `mcpServers` option. Keep hook settings in
`settings`; putting registration there does not work.

```ts
query({
  prompt,
  options: {
    sessionId, // chosen and recorded before launch
    model: "haiku",
    settings: "/absolute/run/hooks.json",
    mcpServers: { loom: serverEntry },
  },
});
```

The opt-in smoke test uses the supported headless CLI alternative, `claude --print --model haiku
--mcp-config <private-file>`, against the real local HTTP endpoint. It enables only
`mcp__loom__get_task_context`, disables built-in tools and other MCP configs, and verifies the
server-side context-read receipt.

### Codex

Register in Codex's `mcp_servers` configuration, using per-process `-c` overrides for Loom runs.
`codex mcp add` is the persistent registration alternative; Loom does not edit global config.
Stdio can forward the coordinator-supplied environment variable:

```sh
codex \
  -c 'mcp_servers.loom.command="node"' \
  -c 'mcp_servers.loom.args=["/absolute/coordinator/mcp-entry.mjs"]' \
  -c 'mcp_servers.loom.env_vars=["LOOM_MCP_TOKEN"]'
```

For HTTP:

```sh
codex \
  -c 'mcp_servers.loom.url="http://127.0.0.1:47802/mcp"' \
  -c 'mcp_servers.loom.bearer_token_env_var="LOOM_MCP_TOKEN"'
```

The process must already have the run's `LOOM_MCP_TOKEN`. These are configuration examples,
not commands run by this package. See the [official Codex MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Contracts and verification

No core contracts were changed. The brief's schema-location sentence conflicts with its own
reference to decision 19, the shared Phase 2 prohibition on core edits, and the comments in
`packages/core/src/mcp.ts`. Schemas therefore live in [src/schemas.ts](src/schemas.ts); the
[type-level test](src/schemas.test.ts) proves all seven inputs and outputs equal their core
contracts while preserving brands. Core remains free of runtime dependencies.

```sh
pnpm test
pnpm lint
pnpm typecheck
LOOM_REAL_PROVIDERS=1 pnpm exec vitest run packages/mcp/src/real.test.ts
```

Normal tests use SDK clients, in-memory hosts and synthetic immutable blob fixtures; no real
agents. They cover every tool, every MCP error, expired tokens, identity isolation, anchor
construction, multiple failed guards, disposition correlation, idempotent persisted inputs,
stdio framing and loopback HTTP. Network tests need permission to bind local ports. `pnpm
typecheck` runs the schema type-equality assertions; Vitest alone does not typecheck them.

The real Haiku test passed on 2026-09-12: one context read through a separate MCP config, no
persisted inputs. The SDK requires `outputSchema.type = "object"` even when the JSON Schema
represents the success/error union. Tests exercise that requirement through `tools/list`.
Interactive Claude and real Codex registration are documented but were not exercised here.

## Lead identity

The coordinator supplies `leadHost` and resolves its private session token to `{kind: "lead",
active: true}`. This identity lists only the Lead tools exported by `leadInputSchemas`; their
schemas reuse `@loom/protocol` human commands and task creation. Task-run identities cannot invoke
Lead tools by name, and Lead cannot invoke run-result tools. A stopped Lead token is inactive.

Lead mutations return the same command outcome as the CLI, inside the MCP result's `value`.
A `human` outcome records an inbox input, not a passed guard; `inspect_task` reads the current
persisted diagnostics including rejected input receipts. `create_task` accepts the same fields as
the protocol command (use null for repository defaults and an empty `blockedBy` array).
