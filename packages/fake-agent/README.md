# @loom/fake-agent

Scripted, in-memory Codex, Claude, pane-host and GitHub adapters for tests. Scenario tools call
`@loom/mcp` through SDK `InMemoryTransport`; the default host commits inputs through the real core
reconciler. Nothing starts an agent, terminal, daemon or network connection.

```ts
const clock = new FakeClock();
const adapters = createFakeAdapters(clock, state, initialPullRequest);
const result = await runScenario({
  scenarios: await loadScenarios(new URL("./scenario.json", import.meta.url)),
  state,
  clock,
  adapters,
  observe: async (runner) => observeFakes(runner, await readGit()),
  onAction: async (action, runner) => testExecutor(action, runner),
  commit: async ({ files, message, human }, runner) => commitFixture(files, message, human),
});
// result.state, result.transitions, result.actions, result.dispositions, result.steps
```

`state` is copied, retaining its pure config functions. The adapters and clock are caller-owned;
use a fresh set for each independent test. The runner reads each owner again after effects and
advances explicit fake time, never wall-clock timers. Trace IDs from the real MCP server remain
UUIDs; assertions should use returned IDs or placeholders, not fixed UUID values. The default
host timestamps inbox receipts with the fake clock.

## Integration boundary

There is **no executor or coordinator loop** in this package. `onAction` supplies action effects and
returns the core `ActionResult` shape; the runner feeds it back to core and records the resulting
trace. An undefined result leaves the intent pending. Scheduling advances fake time; retries,
delivery timeouts and stage decisions are exclusively core's rules. The test dispatcher in
`src/test-support.ts` is private test code, using actual commits in temporary Git repositories and
the real Git adapter for clean-tree/ancestry observations.

A start handler must create or resume the fake provider session and return its recorded ID. The
runner binds its scenario only after that action result is committed. `FakeProviders.create` also
supports Claude interactive launches, whose real launch command belongs to the pane host. For
interactive Claude sends, the test executor must explicitly connect the known run's pane write to
`providers.enqueue`; `paneHost.pasteText` only records bytes, and cannot identify sessions or
confirm delivery. `providers.answer` simulates a human answering Claude's native dialog.

`mcp(runner, defaults)` can replace the default `McpHost`, token resolver or anchor reader while
retaining the real MCP server. A supplied host must commit through `runner.pass` (or otherwise
synchronize its authoritative state with the runner) to include its transitions in the trace.
The default host rejects file-level review locations; supply a real immutable-blob anchor reader
for those tests. Task-level findings work without extra setup. `afterPass` can enqueue explicit
human commands with `runner.input(command)`.

## Playback rules

- JSON uses the `Scenario`/`Step` shapes in [src/scenario.ts](src/scenario.ts). Unknown fields, invalid regexes,
  negative durations and unknown tools fail zod validation. Tool payload validation happens at
  the real MCP boundary, so scripts can deliberately expect `invalid_input`.
- Match on provider, role, mode and optional attempt. An exact attempt match wins; otherwise the
  first unused matching script plays. The same script is never silently reused on a retry.
- `expect: "message"` consumes the next send, optionally matching a regular expression. It emits
  Codex `turn/started` (or a user-message item for steering), or Claude `UserPromptSubmit`.
  A transport return alone never changes activity or confirms delivery.
- `dropDelivery` suppresses receipts for the remainder of that attempt. A script can stall to
  inspect core's timeout/retry path, or expect a message to verify that the expectation times out.
- `$HEAD`, `$FINDING_0`, `$QUESTION_0`, etc. are replaced recursively in tool input values. IDs are
  zero-based in current task creation order. Missing values fail loudly.
- Steps execute in order, one observable effect per pass. A stall blocks only its own script.
  Request steps wait for the native answer and verify accept/decline/answer.
- A crash is a fault, not a successful submission. Claude loses its agents entry without
  SessionEnd; Codex loses its connection. Recovery is explicit. A run ending or retrying with
  unconsumed steps fails, as do unused scenarios, unmet expectations and the bounded step limit.
- GitHub pushes change the fake remote head; opening a PR is a separate action. CI IDs stay stable
  across completion of the same check and change for a new head. Git steps require the caller's
  commit callback, allowing real temporary Git repositories.

Tests cover the one-fix-round workflow, crash/retry, dropped delivery, duplicate hints, cooldown,
human pushes, CI after approval, vanished interactive runs, MCP validation/authentication,
questions/approvals, snapshot isolation, and adapter idempotency. These tests use fake providers.
