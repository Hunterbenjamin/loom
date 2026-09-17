# Using Loom on a project alongside Loom development

Run `dev` from your Loom development checkout and `stable` from a second clone of the same
repository. Both use `scripts/dev.sh`. Stable runs the revision you chose; merges in dev do not
update or restart it. Only an explicit `scripts/dev.sh sync` fetches and fast-forwards the running
checkout, and only on its clean base branch. `up` and `restart` use the checked-out revision.

## Create and configure stable

```sh
git clone https://github.com/Hunterbenjamin/loom.git ~/Projects/loom-stable
cd ~/Projects/loom-stable
pnpm install --frozen-lockfile
mkdir -p ~/.loom-stable/stable
chmod 700 ~/.loom-stable ~/.loom-stable/stable
```

Create `~/.loom-stable/stable/env` with the following contents. Generate a private token with
`openssl rand -hex 32` and put it in the file; do not commit or share it.

```sh
export LOOM_INSTANCE=stable
export LOOM_DATA_ROOT="$HOME/.loom-stable"
export LOOM_TOKEN='<your private token, at least 16 characters>'
export LOOM_BIND=127.0.0.1:47810
export LOOM_MCP_PORT=47811
export LOOM_HOOK_PORT=47812
export LOOM_RENDERER_PORT=5174
export LOOM_DEBUG_PORT=9223
```

```sh
chmod 600 ~/.loom-stable/stable/env
```

Use **different data roots**, even with different instance names. Task worktrees still default to
`$LOOM_DATA_ROOT/worktrees`; keeping this default preserves existing dev worktrees. Stable uses
`~/.loom-stable/worktrees`, and its database, logs, provider files and Electron profile live under
`~/.loom-stable/stable`. Its private tmux socket is `loom-stable`; dev uses `loom-dev`.

| Listener | Dev default | Stable example | Environment variable |
|---|---|---|---|
| Protocol | 127.0.0.1:47800 | 127.0.0.1:47810 | `LOOM_BIND` |
| Agent MCP | 47801 | 47811 | `LOOM_MCP_PORT` |
| Claude hooks | 47802 | 47812 | `LOOM_HOOK_PORT` |
| Renderer | 5173 | 5174 | `LOOM_RENDERER_PORT` |
| Chromium debugging | Disabled | 9223 | `LOOM_DEBUG_PORT` |

MCP and hook ports default to the protocol port plus one and two. Debugging is optional; omit
`LOOM_DEBUG_PORT` to disable it. Give dev its own debug port, such as 9222, if you need both.
An occupied port fails startup and identifies its variable; Vite never chooses another port.
`LOOM_BIND_PORT` is not used. Restart the affected process after changing its env file.

## Register a project and start

Select the instance **before** invoking the launcher so it can locate the right env file. In a
fresh terminal:

```sh
cd ~/Projects/loom-stable
export LOOM_INSTANCE=stable LOOM_DATA_ROOT="$HOME/.loom-stable"
set -a
. "$LOOM_DATA_ROOT/$LOOM_INSTANCE/env"
set +a
# Offline registration before the first start; use your project's local path and GitHub name.
pnpm loom repo add ~/Projects/example owner/example
scripts/dev.sh up
scripts/dev.sh status
scripts/dev.sh install-launcher
```

You can also use **Add repository…** in the running stable window. Confirm its `stable` badge
before opening a project. Both Tracker and Workbench display the instance, and window titles
include it. Registrations, settings and issues belong only to that instance.

The Dock launcher is `~/Applications/Loom stable.app`; installing it preserves `Loom Dev.app`.
It remembers the checkout, instance and data root even when launched from Finder. Its notifications
name the instance. Desktop **Instance: sync** and **Update and Restart** target that app's checkout.
The running Electron bundle may still say Loom in the Dock; the window title and sidebar badge
identify the instance.

## Update or stop stable deliberately

From the stable terminal configured above:

```sh
scripts/dev.sh sync          # explicitly adopt latest main, restarting stale processes
scripts/dev.sh restart app   # rebuild/restart the current revision without pulling
scripts/dev.sh down          # stop stable coordinator and desktop only
```

Use a separate terminal with dev's environment for dev. `status` prints the selected instance,
data root, checkout and resolved ports. Process detection and shutdown are scoped to that
instance's coordinator and desktop tmux panes. A listener belonging to another process is a port
conflict, not evidence that this instance is already running.

If you initially clone a feature branch to try an unreleased change, `sync` deliberately leaves
that branch alone. After it merges, explicitly switch the stable clone to `main` and run `sync`.
Do not share a working checkout or Electron build directory between running instances.
