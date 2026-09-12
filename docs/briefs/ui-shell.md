# UI shell: the Linear-style window, on fixtures

**Agent:** claude, Opus · **Branch:** `feat/ui-shell` · **Timebox:** about 3 hours, counted from your
first commit. Time spent waiting for a human's approval doesn't count.

## Why

The window is the part of Loom the human judges hardest, and nothing else is built to a feel. This
builds it early against fixed sample data, so we can find out whether the density, navigation and
keyboard flow are right while changing them is still cheap, and whether the performance budget holds on
this machine before any product code depends on the answer.

It is a shell. No coordinator, no agents, no network, no persistence.

## Scope

**In:** `apps/desktop` only. Electron, React, TypeScript.

**Out:** the coordinator, adapters, MCP, storage, authentication, settings, anything that reads the
user's real repositories or starts a real agent. Don't create other packages, and don't change
`packages/core`; if its types are awkward to render, say so in the PR instead of editing them.

## Build

Render everything from an in-memory fixture store typed with `@loom/core`, which is already on `main`.
Using the real entity types is deliberate: it tests the Phase 1a design against its first consumer.

- **Fixtures:** about 40 tasks spread across every stage, with runs, attention reasons, flags, findings
  (including `moved` and `outdated` mappings), approvals, plans, test results and a transition log.
  Include the awkward cases: long titles, a task with three runs, a blocked run waiting on a permission,
  a failed run, a task with 200 findings.
- **Sidebar:** views (All, Needs you, In progress, Awaiting approval, Done) with counts, and a repo
  selector.
- **List view:** virtualized, grouped by stage, sortable, with stage, attention, provider, round and age
  columns.
- **Board:** a column per stage, cards showing attention and the running agent, drag to move.
- **Issue detail** with tabs: Activity (the transition log and run events), Plan, Agents (each run with
  its status, provider, model and session ID), Terminal, Changes, Review.
- **Terminal tab:** xterm.js 6 with the WebGL, fit and unicode-graphemes addons, over node-pty, plus the
  kitty key shim spike 03 specified (Shift+Enter as `\e[13;2u`). It runs a plain shell by default. If
  `LOOM_ATTACH_AGENT=<name>` is set it runs `herdr agent attach <name>` instead, which is how the
  performance test gets a real agent. Never start or control an agent yourself.
- **Changes and Review tabs:** `@pierre/diffs` with `CodeView` and a worker pool, showing a fixture
  patch, with findings rendered in annotation slots as spike 04 describes, a file list, viewed state,
  and comment threads that live in the fixture store.
- **Command palette** (cmdk) and shortcuts: `cmd+k`, `g` then `i`/`b`/`n` to switch view, `j`/`k` to
  move, `enter` to open, `esc` to close, `c` to create, `/` to search, `e` to change stage. Every action
  reachable by keyboard.
- **Theme:** dark and light, compact rows (about 32 px), muted palette, hairline borders rather than
  shadows. Take the spirit of Linear's density; don't copy its exact visuals.

## Performance budget

Treat these as requirements, not aspirations. Measure with a Playwright harness, the same method spike
03 used (launch Electron with background throttling disabled, or a covered window stalls
`requestAnimationFrame`), and write the numbers to `apps/desktop/perf/report.json`. Fail the test when a
budget is missed.

| What | Budget |
|---|---|
| Keystroke to glyph in the terminal, p95 | ≤ 16 ms |
| Scrolling a 500-row list | ≥ 110 fps, no frame gap over 32 ms |
| Switching view or opening an issue, p95 | ≤ 50 ms |
| Rendering a 50-file diff, first paint | ≤ 400 ms |
| Cold start to interactive | ≤ 1.5 s |
| Idle CPU with the window open | ≤ 3% of one core |

Rules that keep it there: render only from the in-memory snapshot, never from disk or network during an
interaction; virtualize every list and the board; no layout reads in scroll handlers; keep React state
updates local to the panel that changed.

Known traps from spike 03: npm drops the exec bit on node-pty's `spawn-helper` (add a postinstall
`chmod +x`), and Electron needs `disable-backgrounding-occluded-windows` for the harness to run.

## Deliverable

A PR titled "UI shell on fixtures", containing the app, the fixture store, the performance harness, and
a README section on running it (`pnpm --filter @loom/desktop dev`) and the harness. In the PR
description include:

- **Measured numbers against every budget row**, on this machine, and what you did if one missed.
- **Feedback on `@loom/core`'s types**: anything awkward or missing for a UI to render, which is input
  to `packages/protocol`.
- **Screenshots** of the list, board, issue detail, and the review tab in both themes.

## Rules

- Follow `AGENTS.md`.
- New dependencies only for what this brief names; no state library beyond React and no data-fetching
  library, since there's nothing to fetch.
- Run `pnpm test`, `pnpm lint` and `pnpm typecheck` before opening the PR.
- Open the PR and stop. Don't merge.
