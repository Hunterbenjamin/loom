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
  research?: import("@loom/adapter-claude").BriefResearch;
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
  /** Existing adapter only: conversation reads must never launch an app-server. */
  codexIfRunning(taskId: TaskId): CodexAdapter | null;
  /** Stop a specific task's app-server without affecting others. Idempotent. */
  stopCodexServer(taskId: TaskId): Promise<void>;
  /** Count of running Codex app-servers. */
  codexServerCount(): number;
  /** Whether this task currently owns a started Codex app-server. */
  codexServerRunning(taskId: TaskId): boolean;
  /** Stops the child processes this coordinator started. Never a shared daemon. */
  close(): Promise<void>;
}

/** Reports a failed adapter operation without changing its result semantics. */
export type ReportAdapterFailure = (operation: string, error: unknown) => void;

export type CodexFactory = (
  taskId: TaskId,
  taskDirectory: string,
) => CodexAdapter;

/** Keeps one Codex adapter per task and starts its server on first use. */
export function codexPerTask(
  dataDirectory: string,
  factory: CodexFactory,
): Pick<
  Adapters,
  | "codex"
  | "codexIfRunning"
  | "stopCodexServer"
  | "codexServerCount"
  | "codexServerRunning"
  | "close"
> {
  const servers = new Map<string, CodexAdapter>();
  /** Each server's start, so concurrent callers share it rather than using a server mid-start. */
  const started = new WeakMap<CodexAdapter, Promise<void>>();
  return {
    async codex(taskId) {
      let adapter = servers.get(taskId);
      if (!adapter) {
        adapter = factory(taskId, join(dataDirectory, "codex", taskId));
        servers.set(taskId, adapter);
      }
      let start = started.get(adapter);
      if (!start) {
        const owner = adapter;
        start = owner.startServer();
        started.set(owner, start);
        // A failed start is tried again by the next caller, as before.
        start.catch(() => {
          if (started.get(owner) === start) started.delete(owner);
        });
      }
      await start;
      return adapter;
    },
    codexIfRunning(taskId) {
      return servers.get(taskId) ?? null;
    },
    async stopCodexServer(taskId) {
      const adapter = servers.get(taskId);
      if (!adapter) return;
      // Forget it first: the count stays honest, and a later use starts a fresh server.
      servers.delete(taskId);
      await adapter.stopServer().catch(() => undefined);
    },
    codexServerCount() {
      return servers.size;
    },
    codexServerRunning(taskId) {
      return servers.has(taskId);
    },
    async close() {
      const all = [...servers.values()];
      servers.clear();
      await Promise.all(all.map((a) => a.stopServer().catch(() => undefined)));
    },
  };
}
