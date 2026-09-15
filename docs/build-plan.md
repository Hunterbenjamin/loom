# Development status

The initial build phases are complete enough for Loom to run its own issue workflow. This file
is retained as an entry point for older links; current behavior is documented in
[architecture](architecture.md), [core workflow](design/core.md) and [UI](design/ui.md).
Implementation work and future scope belong in issues, not a second roadmap here.

Use the [development launcher](../README.md#development) to update a running checkout. There is
no `loom release` command. The human chooses which work runs through Loom and which runs in an
independent worktree. Keep development instances and test resources isolated as required by
[AGENTS.md](../AGENTS.md#safety).

The [spikes](../spikes/README.md) are historical integration experiments, not the current contract.
