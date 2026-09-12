# @loom/desktop

The Loom window: a Linear-style view of tasks, runs, plans, findings and diffs.

**This is a shell.** There is no coordinator, no adapters, no network and no persistence. Every
panel renders from one in-memory snapshot built in `src/renderer/fixtures`, typed with
`@loom/core`'s real entity types. Closing the window loses everything, which is fine here and
will stay fine later: the UI holds no durable state (principle 5).

The one thing that is real is the Terminal tab, which runs a PTY through the Electron main
process, because latency and key handling can only be judged against a real one.

## Running it

```sh
pnpm install
pnpm --filter @loom/desktop dev      # vite dev server + Electron, with hot reload
pnpm --filter @loom/desktop build    # production build into apps/desktop/out
pnpm --filter @loom/desktop start    # run the production build
```

If Electron's binary has not been downloaded yet (pnpm skips the install script until the
package is allow-listed), run `node node_modules/electron/install.js` inside `apps/desktop`.

The Terminal tab runs a login shell by default. To point it at a real agent instead:

```sh
LOOM_ATTACH_PANE=<session>:<window-id> pnpm --filter @loom/desktop dev
```

That attaches a client to a pane on the pane host, which is a viewer. Loom never starts, prompts or stops an
agent from here.

| Variable | Effect |
|---|---|
| `LOOM_ATTACH_PANE` | Attach to `<session>:<window-id>` on the pane host in the Terminal tab instead of running a shell. |
| `LOOM_TMUX_BIN` | Absolute path to `tmux`, if it is not on `PATH`. |
| `LOOM_INSTANCE` | Pane-host instance; the socket is `loom-<instance>`. Defaults to `dev`. |
| `LOOM_TASKS` | Number of fixture tasks. Only the performance harness sets this (500). |
| `LOOM_WIDTH`, `LOOM_HEIGHT` | Window size at launch. |

## Keyboard

Every action is reachable from the keyboard.

| Key | Action |
|---|---|
| `cmd+k` | Command palette (also creates tasks and jumps to one) |
| `g` then `i` / `b` | List / board |
| `g` then `n` | The "Needs you" view |
| `j` / `k` | Move the cursor |
| `enter` | Open the task under the cursor |
| `esc` | Close the palette, the search field, then the issue |
| `c` | Create a task |
| `/` | Search |
| `e` | Change stage |
| `alt+↑` / `alt+↓` | Previous / next file, in Changes and Review |

## The performance harness

```sh
pnpm --filter @loom/desktop build
pnpm --filter @loom/desktop perf
```

It launches the built app with Playwright's Electron driver, drives the real renderer, writes
`perf/report.json`, and exits non-zero when a budget in `perf/budgets.json` is missed. `pnpm test`
then re-checks the committed report against those budgets, so a regression fails the suite even
when nobody reruns the harness.

Two details from spike 03 matter: Electron is launched with
`disable-backgrounding-occluded-windows` (a covered window stalls `requestAnimationFrame` and the
run hangs), and CPU is read from `ps`, because Electron's own `percentCPUUsage` under-reports by
roughly eight times.

## Layout

```
src/main         Electron main: the window and the PTYs. Nothing else.
src/preload      The contextBridge, typed by src/shared/ipc.ts
src/renderer
  fixtures/      the snapshot, built from @loom/core types; deterministic
  store/         one store, one subscription, selectors with memoized derivations
  ui/            sidebar, list, board, detail and its tabs, palette, terminal, diff
perf/            the Playwright harness, its budgets and its last report
```
