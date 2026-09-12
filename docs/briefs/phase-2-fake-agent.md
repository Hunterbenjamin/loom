# Phase 2: `packages/fake-agent`

**Agent:** codex · **Branch:** `feat/fake-agent` · **PR title:** "Phase 2: fake-agent". Read
[`phase-2-common.md`](phase-2-common.md) first; the package shape and rules apply, with the path
`packages/fake-agent`.

## Build

The scripted provider that every automated test uses instead of a real agent, per
[`docs/design/core.md`](../design/core.md) §9. It implements the provider side of the adapter
interfaces in `packages/core/src/adapters.ts` in memory, driven by scenarios, with a fake clock.

- **Fakes:** `CodexAdapter`, `ClaudeAdapter`, `PaneHost` and `GitHubAdapter`. Each produces the
  same observation shapes the real adapters do (look at their fixtures under
  `packages/adapters/*/src/fixtures` for realistic values), including the required fields:
  `resumable`, `activityAt`, check-run IDs. Git may be real: throwaway repositories in the OS temp
  directory are fast and honest, and the real git adapter already exists.
- **Scenarios:** the `Scenario` and `Step` types from §9, loaded from JSON and validated with zod.
  A scenario is matched to a run on provider, role and mode when Loom starts one. Steps run in order;
  each waits for the one before. `$HEAD`, `$FINDING_<n>` and `$QUESTION_<n>` are substituted at run
  time. Leftover steps when the run ends fail the test.
- **The MCP path is real:** a scenario's `tool` step calls the real `@loom/mcp` server with the
  run's token, through its in-memory host or a host the test supplies. That is how the reconciler is
  exercised end to end without an agent.
- **Delivery is confirmed the provider's way:** an `expect: "message"` step completes only when the
  fake provider emits the equivalent of `turn/started` or `UserPromptSubmit`, so `dropDelivery` tests
  the coordinator's timeout path honestly.
- **`runScenario` API** for the coordinator's future tests: give it a scenario set, a `TaskState`, the
  fake adapters and the clock; get back the transitions, actions and dispositions that occurred.

## Tests

The example scenario in §9 (an implementer with one fix round) runs through the real
`packages/core` reconciler and the real MCP server and ends in `awaiting_approval`. Add scenarios for:
a crash mid-turn with retry, a dropped delivery, a duplicate event, a rate limit with cooldown, a
human pushing to the branch, CI failing after approval, and an interactive run vanishing. No real
agent, no network.

## Out of scope

The executor and the coordinator loop. This package makes them testable; it doesn't include them.
