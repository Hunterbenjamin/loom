# Desktop: fix the Terminal tab's resize loop; merge Changes into Review

**Agent:** codex · **Branch:** `fix/desktop-terminal` · **PR title:** "desktop: stop the Terminal
tab's resize loop; merge Changes into Review" · **Timebox:** about 2 hours from your first commit.
Read [`phase-2-common.md`](phase-2-common.md) for the shared rules; the package is `apps/desktop`.

## The bug

With `LOOM_ATTACH_PANE=<session>:<window-id>` set, the Terminal tab flickers, grows wider without
bound, and the panel's horizontal scrollbar keeps extending. Reported by the human on the first real
use, against a live Codex agent on the tmux pane host.

Almost certainly a feedback loop: the fit addon computes columns from the container's size, the
resize is sent to the PTY, tmux (`window-size latest`) resizes the pane to the attached client, the
redraw makes the terminal element wider than its parent, the parent grows because nothing constrains
it, and the next fit sees a wider container. Confirm the cause before fixing it; if it's something
else, say so in the PR.

## Fix

- The terminal's container must have a fixed, constrained box: `min-width: 0` on the flex child,
  `overflow: hidden`, height and width from layout, never from the terminal's own canvas.
- Fit only when the container's size changes (a `ResizeObserver` on the container, debounced), and
  only send a resize to the PTY when cols or rows actually changed.
- Never let the terminal element's intrinsic size feed back into the layout that sizes it.
- The panel must not scroll horizontally at all; tmux handles wrapping inside the pane.

## The tab merge

Fold the Changes tab into the Review tab: one tab, the file list, the diff with findings in
annotation slots, and the review range control. Remove the Changes tab and its shortcut, update the
keyboard map in the README and the palette, and keep the fixtures and the performance harness
passing.

## Tests

- A Playwright regression in `apps/desktop/perf` or beside the existing harness: attach the terminal
  to a real PTY (a shell is fine; `LOOM_ATTACH_PANE` against a throwaway `tmux -L loom-test-<pid>`
  server is better), resize the window twice, and assert that cols and rows stabilize within a few
  frames and the container's `scrollWidth` never exceeds its `clientWidth`.
- The existing harness still passes every budget; commit the refreshed `perf/report.json`.

## Out of scope

The Workbench, any change to `packages/*`, and any other UI refinement. The human wants to start
using the app before refining it further.
