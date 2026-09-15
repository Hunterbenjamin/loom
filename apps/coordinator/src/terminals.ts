import { homedir } from "node:os";
import type { IsoTime, RepoId, WorktreePath } from "@loom/core";
import { paneIdentity } from "@loom/protocol";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import type { Handlers } from "./commands.js";
import type { CoordinatorConfig } from "./config.js";
import { type PaneInventory, paneKey } from "./pane-inventory.js";
import { runEnvironment } from "./recipes.js";
import { openTaskTerminal } from "./task-terminal.js";

type TerminalKind =
  | "set_title"
  | "open_task_terminal"
  | "open_workbench_terminal"
  | "open_pane_session"
  | "close_terminal"
  | "create_scratch";

interface TerminalDeps {
  store: Store;
  adapters: Adapters;
  config: CoordinatorConfig;
  inventory: PaneInventory;
  repo(id: RepoId): { root: WorktreePath };
  now(): IsoTime;
}

const requireOwned = (
  hostGeneration: string,
  instance: string,
  subject: "Terminal" | "Pane",
) => {
  if (!hostGeneration.startsWith(`loom-${instance}#`))
    throw new Error(`${subject} belongs to another instance`);
};

export function terminalHandlers(deps: TerminalDeps): Handlers<TerminalKind> {
  return {
    set_title: async (command) => {
      requireOwned(command.hostGeneration, deps.config.instance, "Terminal");
      await deps.adapters.paneHost.setTitle({
        hostGeneration: command.hostGeneration,
        target: command.target,
        title: command.title,
      });
      await deps.inventory.refresh();
      return { ok: true, result: { kind: "titled" } };
    },
    open_task_terminal: async (command) => {
      const state = deps.store.loadTaskState(command.taskId);
      const repo = deps.store
        .repos()
        .find((value) => value.id === state.task.repoId);
      if (!repo) throw new Error("Task project is unavailable");
      const terminal = await openTaskTerminal(state, repo, deps.adapters);
      await deps.inventory.refresh();
      return {
        ok: true,
        result: { kind: "task_terminal", taskId: command.taskId, ...terminal },
      };
    },
    open_workbench_terminal: async (command) => {
      const scratchTarget = command.target
        ? paneIdentity.parse(command.target)
        : undefined;
      if (scratchTarget)
        requireOwned(
          scratchTarget.hostGeneration,
          deps.config.instance,
          "Pane",
        );
      const scratchPane = scratchTarget
        ? await deps.adapters.paneHost.getPane(scratchTarget)
        : null;
      if (
        scratchTarget &&
        (!scratchPane ||
          scratchPane.dead ||
          scratchPane.ref.windowId !== scratchTarget.windowId)
      )
        throw new Error("Pane is missing, dead or stale");
      if (command.split && !scratchTarget)
        throw new Error("Split requires a target pane");
      // A new space opens at the selected project's root, so its shell is in the repo.
      const newSpace = !scratchTarget ? command.workspace : undefined;
      const selectedRepoId = newSpace ? deps.store.selectedRepo() : null;
      const spaceRoot = selectedRepoId ? deps.repo(selectedRepoId).root : null;
      const ref = await deps.adapters.paneHost.createScratch({
        workspaceId: newSpace ?? scratchPane?.workspaceId ?? "loom-workbench",
        target: scratchTarget,
        split: command.split,
        createWorkspace: true,
        key: command.key,
        label: command.label ?? "Terminal",
        cwd: spaceRoot ?? scratchPane?.startCwd ?? (homedir() as WorktreePath),
        executable: process.env.SHELL || "/bin/sh",
        args: ["-l"],
        env: runEnvironment(process.env, {}),
      });
      await deps.inventory.refresh();
      return attachSession(deps, ref);
    },
    open_pane_session: async (command) => {
      const ref = paneIdentity.parse(command.target);
      return attachSession(deps, ref);
    },
    close_terminal: async (command) => {
      const ref = paneIdentity.parse(command.target);
      requireOwned(ref.hostGeneration, deps.config.instance, "Pane");
      if (
        ref.sessionName.startsWith("loom-lead-") ||
        ["loom-lead", "loom-main"].includes(ref.sessionName)
      )
        throw new Error(
          "Pinned agents are stopped through their agent controls",
        );
      // A task's supervisor would recover an unannounced terminal death. Require
      // its normal stop control instead of reporting a close that immediately reopens.
      const scope = command.scope ?? "pane";
      const inScope = (pane: {
        sessionName: string;
        windowId: string;
        paneId: string;
      }) =>
        pane.sessionName === ref.sessionName &&
        (scope === "session" ||
          (pane.windowId === ref.windowId &&
            (scope === "window" || pane.paneId === ref.paneId)));
      const active = deps.store
        .tasks()
        .flatMap((task) => deps.store.runs(task.id))
        .find(
          (run) =>
            !run.endedAt &&
            run.pane &&
            run.pane.hostGeneration === ref.hostGeneration &&
            inScope(run.pane),
        );
      if (active)
        throw new Error(
          "Stop the running task before closing its agent terminal",
        );
      if (scope === "session") await deps.adapters.paneHost.closeSession(ref);
      else if (scope === "window")
        await deps.adapters.paneHost.closeWindow(ref);
      else await deps.adapters.paneHost.closeTerminal(ref);
      if (await deps.adapters.paneHost.getPane(ref))
        throw new Error("Terminal closure was not confirmed");
      await deps.inventory.refresh();
      return { ok: true, result: { kind: "terminal_closed", target: ref } };
    },
    create_scratch: async (command) => {
      const state = deps.store.loadTaskState(command.taskId);
      if (!state.worktree?.paneWorkspaceId)
        throw new Error("Task has no existing pane workspace");
      const ref = await deps.adapters.paneHost.createScratch({
        workspaceId: state.worktree.paneWorkspaceId,
        createWorkspace: true,
        cwd: state.worktree.path,
        key: command.key,
        label: command.label,
        executable: process.env.SHELL || "/bin/sh",
        args: ["-l"],
        env: runEnvironment(process.env, {}),
      });
      await deps.inventory.refresh();
      const pane = deps.inventory.rows.find(
        (value) => value.id === paneKey(ref),
      );
      if (!pane) throw new Error("Scratch created but inventory unavailable");
      return { ok: true, result: { kind: "scratch_created", pane } };
    },
  };
}

async function attachSession(
  deps: TerminalDeps,
  ref: ReturnType<typeof paneIdentity.parse>,
) {
  requireOwned(ref.hostGeneration, deps.config.instance, "Pane");
  const pane = await deps.adapters.paneHost.getPane(ref);
  if (!pane || pane.dead || pane.ref.windowId !== ref.windowId)
    throw new Error("Pane is missing, dead or stale");
  return {
    ok: true as const,
    result: {
      kind: "attach_session",
      target: {
        identity: "pane",
        target: pane.ref,
        attach: {
          kind: "pane_host",
          argv: deps.adapters.paneHost.attachArgs(pane.ref),
          cwd: pane.startCwd,
          env: {},
        },
        pane: {
          ...pane.ref,
          dead: false,
          exitStatus: null,
          attachedClients: 0,
          size: null,
          observedAt: deps.now(),
        },
      },
    },
  };
}
