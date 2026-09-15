# @loom/desktop

Electron and React client for the coordinator. [UI](../../docs/design/ui.md) owns current controls,
keyboard behavior and detail layouts; [protocol](../../packages/protocol/README.md) owns the wire
contract. The window has no durable issue state.

## Running

Use the [development launcher](../../README.md#development) for the live app. To run it directly:

```sh
pnpm --filter @loom/desktop dev
pnpm --filter @loom/desktop build
pnpm --filter @loom/desktop start
```

The desktop requires `LOOM_INSTANCE`, `LOOM_DATA_ROOT` and `LOOM_TOKEN`; `LOOM_BIND` has the
[coordinator default](../coordinator/README.md#configuration). Electron main passes the connection
through narrow preload IPC. There is no implicit production instance or local database fallback.
The last snapshot stays visible while disconnected; reconnect takes a fresh snapshot. Commands
are not replayed on reconnect.

`LOOM_WINDOW_MODE` selects initial Tracker/Workbench mode; `LOOM_WIDTH` and `LOOM_HEIGHT` set
the launch size. Stored desktop preferences follow [settings ownership](../../docs/architecture.md#settings).

## Source map

| Location | Responsibility |
|---|---|
| [src/main](src/main) | Windows, protocol connection support, PTYs and native controls |
| [src/preload](src/preload), [src/shared/ipc.ts](src/shared/ipc.ts) | Typed context bridge |
| [renderer/store](src/renderer/store) | Disposable snapshot, patch application, subscriptions and selectors |
| [renderer/ui](src/renderer/ui) | Tracker, combined detail, PR diff, briefs and settings |
| [renderer/workbench](src/renderer/workbench) | Native space/tab projection and terminal controls |
| [renderer/chat](src/renderer/chat) | Floating provider conversation view |
| [renderer/fixtures](src/renderer/fixtures) | Deterministic sample snapshots for tests |
| [perf](perf) | Playwright harness, budgets and recorded reports |

## Focused smoke and performance checks

These checks require a desktop build. Run only the harness relevant to a UI change, separately
from other performance measurements:

```sh
pnpm exec tsx apps/desktop/scripts/tracker-smoke.ts
pnpm exec tsx apps/desktop/scripts/workbench-menu-smoke.ts
node apps/desktop/scripts/keybindings-smoke.mjs
pnpm --filter @loom/desktop perf
pnpm --filter @loom/desktop test:terminal
pnpm --filter @loom/desktop test:workbench
```

Performance and screenshot checks use [desktop-harness.ts](scripts/desktop-harness.ts) to start a
disposable coordinator with fake providers and GitHub. Terminal checks use owned shells on private
`loom-test-<pid>` tmux servers; resources are cleaned up on exit. Tracker smoke also uses fake-agent
with a real coordinator. Performance reports go under `perf/` and are checked against committed budgets.
Electron is launched with background-occlusion throttling disabled so measurements keep rendering.
Colocated component/store tests cover interaction and projection behavior without a full app build.
