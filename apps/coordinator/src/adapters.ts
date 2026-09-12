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
  git: GitAdapter;
  github: GitHubAdapter;
  paneHost: PaneHost;
  claude: ClaudeAdapter;
  /** Per task: `startServer` is idempotent and the server outlives a pane host restart. */
  codex(taskId: TaskId): Promise<CodexAdapter>;
  /** Stops the child processes this coordinator started. Never a shared daemon. */
  close(): Promise<void>;
}

export interface CodexFactory {
  (taskId: TaskId, taskDirectory: string): CodexAdapter;
}

/** Keeps one Codex adapter per task and starts its server on first use. */
export function codexPerTask(
  dataDirectory: string,
  factory: CodexFactory,
): Pick<Adapters, "codex" | "close"> {
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
    async close() {
      const all = [...servers.values()];
      servers.clear();
      await Promise.all(all.map((a) => a.stopServer().catch(() => undefined)));
    },
  };
}
