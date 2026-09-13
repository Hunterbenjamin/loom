// The real adapters, wired for one instance. Every one of them is addressed privately: tmux on
// `-L loom-<instance>`, a Codex app-server per task with its own state directory, and Claude's
// hooks and MCP registration in per-run files. Nothing here touches the user's own tmux servers,
// the shared Codex daemon or global config.

import { join } from "node:path";
import { createClaudeAdapter } from "@loom/adapter-claude";
import { createCodexAdapter } from "@loom/adapter-codex";
import { createGitAdapter } from "@loom/adapter-git";
import { createGitHubAdapter } from "@loom/adapter-github";
import { createTmuxPaneHost } from "@loom/adapter-tmux";
import type { Store } from "@loom/store";
import { type Adapters, codexPerTask } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";

/**
 * The adapter-wide Claude MCP entry is a placeholder: every Loom launch writes the run's own
 * registration with `writeSettings(path, entry)`, which is where the run's token lives. A session
 * started without one registers no Loom tools, which is the right failure.
 */
const PLACEHOLDER = { type: "http", url: "http://127.0.0.1:1/mcp" } as const;

export async function createRealAdapters(
  config: CoordinatorConfig,
  store: Store,
  onError: (error: Error) => void = () => {},
): Promise<Adapters> {
  type Diagnostic = import("@loom/core").AdapterDiagnostic & {
    taskId: string | null;
  };
  const listeners = new Set<(event: Diagnostic) => void>();
  const pending: Diagnostic[] = [];
  const diagnostic = (event: Diagnostic) => {
    if (!listeners.size) pending.push(event);
    for (const listener of listeners) listener(event);
  };
  const git = createGitAdapter();
  const github = createGitHubAdapter({
    excludedAuthors: config.excludedAuthors,
  });
  const paneHost = createTmuxPaneHost({
    instance: config.instance,
    configPath: join(store.dataDirectory, "tmux.conf"),
    tmuxExecutable: config.tmuxExecutable,
  });
  let claude: Awaited<ReturnType<typeof createClaudeAdapter>>;
  try {
    claude = await createClaudeAdapter({
      mcpServer: PLACEHOLDER,
      log: store.hooks,
      receiver: { port: config.hookPort },
      onError,
      onDiagnostic: (event) =>
        diagnostic({
          ...event,
          taskId:
            store
              .tasks()
              .find((t) =>
                store.runs(t.id).some((r) => r.sessionId === event.sessionId),
              )?.id ?? null,
        }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("EADDRINUSE") || message.includes("in use")) {
      throw new Error(
        `Port ${config.hookPort} is in use; set LOOM_HOOK_PORT to a different value`,
      );
    }
    throw error;
  }
  const codex = codexPerTask(store.dataDirectory, (taskId, taskDirectory) =>
    createCodexAdapter({
      taskDirectory,
      executable: config.codexExecutable,
      liveSessionOwners: async () =>
        store
          .runs(taskId)
          .filter(
            (run) => run.provider === "codex" && !run.endedAt && run.sessionId,
          )
          .map((run) => run.sessionId as NonNullable<typeof run.sessionId>),
      onDiagnostic: (event) => diagnostic({ ...event, taskId }),
      onLog: (message) => console.log(`${taskId}: ${message}`),
    }),
  );
  return {
    subscribeDiagnostics(listener) {
      listeners.add(listener);
      for (const event of pending.splice(0)) listener(event);
      return () => {
        listeners.delete(listener);
      };
    },
    git,
    github,
    paneHost,
    claude,
    codex: codex.codex,
    stopCodexServer: codex.stopCodexServer,
    codexServerCount: codex.codexServerCount,
    async close() {
      await codex.close();
      await claude.close();
    },
  };
}
