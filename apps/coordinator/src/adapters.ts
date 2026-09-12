// Everything the coordinator talks to, in one bundle, so tests can replace any of it with a fake.
// One Codex app-server per task, as a Loom child process outside the pane host (design §10).

import { join } from "node:path";
import type {
  ClaudeAdapter,
  CodexAdapter,
  GitAdapter,
  GitHubAdapter,
  PaneHost,
  TaskId,
} from "@loom/core";

export interface Adapters {
  subscribeDiagnostics?(
    listener: (
      event: import("@loom/core").AdapterDiagnostic & { taskId: string | null },
    ) => void,
  ): () => void;
  git: GitAdapter;
  github: GitHubAdapter;
  paneHost: PaneHost;
  claude: ClaudeAdapter;
  /** Per task: `startServer` is idempotent and the server outlives a pane host restart. */
  codex(taskId: TaskId): Promise<CodexAdapter>;
  /** Stop a specific task's app-server without affecting others. Idempotent. */
  stopCodexServer(taskId: TaskId): Promise<void>;
  /** Count of running Codex app-servers. */
  codexServerCount(): number;
  /** Stops the child processes this coordinator started. Never a shared daemon. */
  close(): Promise<void>;
}

export type CodexFactory = (
  taskId: TaskId,
  taskDirectory: string,
) => CodexAdapter;

/** Keeps one Codex adapter per task and starts its server on first use. */
export function codexPerTask(
  dataDirectory: string,
  factory: CodexFactory,
): Pick<Adapters, "codex" | "stopCodexServer" | "codexServerCount" | "close"> {
  const servers = new Map<string, CodexAdapter>();
  return {
    async codex(taskId) {
      const existing = servers.get(taskId);
      if (existing) return existing;
      const adapter = factory(taskId, join(dataDirectory, "codex", taskId));
      servers.set(taskId, adapter);
      await adapter.startServer();
      return adapter;
    },
    async stopCodexServer(taskId) {
      const adapter = servers.get(taskId);
      if (!adapter) return;
      await adapter.stopServer().catch(() => undefined);
    },
    codexServerCount() {
      return servers.size;
    },
    async close() {
      const all = [...servers.values()];
      servers.clear();
      await Promise.all(all.map((a) => a.stopServer().catch(() => undefined)));
    },
  };
}
