# Phase 2: `packages/protocol`

**Agent:** claude, Opus · **Branch:** `feat/protocol` · **PR title:** "Phase 2: coordinator–UI
protocol". Read [`phase-2-common.md`](phase-2-common.md) first, then [`docs/design/ui.md`](../design/ui.md),
and the "Feedback on `@loom/core`'s types" section of PR #18's description, which lists the six gaps
the fixture shell found.

## Build

The typed API between the coordinator and its windows, as zod schemas with inferred types. It is
designed for several windows at once from the start.

- **Snapshot and patches.** A full snapshot on connect, then patches. Patches are small, ordered, and
  carry a sequence number so a client can detect a gap and ask for a fresh snapshot. Define the
  patch model (per-entity upserts and deletes are enough; no generic JSON-patch).
- **Subscriptions.** A client says what it's showing (a task, a view, a diff) and receives only the
  patches for that; everything receives task-list-level changes. Define the subscription messages.
- **Commands.** The human commands from `packages/core/src/observations.ts` (`HumanCommand`), plus
  UI-only requests: open an attach session for a run, fetch a diff for a range, save review-shell
  state. Each command gets an acknowledgement with the input ID or a typed error.
- **Derived views the UI needs**, each a schema:
  - attention with a `since` **per reason**;
  - per run: its attach target and pane-host state;
  - per task: the changed-files model (path, previous path, status, binary, counts, stable file ID,
    monotonic version) and the review range (whole branch, or since the last reviewed head);
  - comment threads on findings, and review-shell state (viewed files, drafts, current file), both
    coordinator-owned.
- **Transport:** a WebSocket on the coordinator's bind address with a token, loopback by default.
  Define the framing and the auth handshake; don't build the server.
- **One core change is expected:** export the attention derivation from `packages/core` as a pure
  function (it exists inside `flags.ts`), and give `Attention` a `since` per reason. List both under
  "Contract changes". Nothing else in core.

## Tests

Every schema round-trips; a fake client applies a snapshot and a patch stream and ends with the same
state a fresh snapshot gives; a gap in sequence numbers is detected; a subscription filters correctly.
The shell's fixture store (`apps/desktop/src/renderer/fixtures`) should be convertible to a
protocol snapshot with a small adapter; do that conversion as a test, so the two can't drift.

## Out of scope

The coordinator's WebSocket server, the UI changes, and persistence of review-shell state (the store
does that).
