// The Claude Code adapter.
//
// Status comes from `claude agents --json`; hooks arriving at the receiver are hints and detail
// (spike 02). Loom launches interactive runs in a pane-host pane and headless runs over the Agent SDK,
// always with a session ID it chose itself and a per-run settings file it wrote itself.

import type {
  ClaudeAdapter,
  ClaudeAgentsEntry,
  ClaudeHookSummary,
  ClaudeSessionObservation,
  IsoTime,
  OnHint,
  ProviderSessionId,
  Unsubscribe,
  WorktreePath,
} from "@loom/core";
import type { AgentsReaderOptions } from "./agents.js";
import { readAgents } from "./agents.js";
import type { StartHeadlessRequest } from "./headless.js";
import { HeadlessRun, isResumable } from "./headless.js";
import type { HookLog, HookReceipt } from "./hooks.js";
import {
  foldHookSummary,
  isIgnoredSubagentEvent,
  MemoryHookLog,
} from "./hooks.js";
import type { HookReceiver } from "./receiver.js";
import { startHookReceiver } from "./receiver.js";
import type { McpServerEntry } from "./settings.js";
import {
  mcpConfigPathFor,
  readMcpConfig,
  writeSettingsFiles,
} from "./settings.js";

export * from "./agents.js";
export * from "./headless.js";
export * from "./hooks.js";
export * from "./receiver.js";
export * from "./settings.js";

export interface ClaudeAdapterConfig {
  /** Loom's MCP server, as Claude should spawn it. One per coordinator, not per run. */
  mcpServer: McpServerEntry;
  /** Tools appear inside Claude as `mcp__<name>__*`. */
  mcpServerName?: string;
  agents?: AgentsReaderOptions;
  /** Defaults to an in-memory log; `packages/store` supplies a durable one. */
  log?: HookLog;
  receiver?: { host?: string; port?: number };
  now?: () => IsoTime;
  onError?: (error: Error) => void;
}

export interface ClaudeAdapterHandle extends ClaudeAdapter {
  /** Where the hooks point. Written into every per-run settings file. */
  readonly hookBaseUrl: string;
  /** Stops the receiver and every headless run this adapter started. */
  close(): Promise<void>;
}

export async function createClaudeAdapter(
  config: ClaudeAdapterConfig,
): Promise<ClaudeAdapterHandle> {
  const log = config.log ?? new MemoryHookLog();
  const mcpServerName = config.mcpServerName ?? "loom";
  const listeners = new Set<OnHint>();
  const headlessRuns = new Map<ProviderSessionId, HeadlessRun>();

  const onReceipt = (receipt: HookReceipt): void => {
    // An internal subagent stops on most turns and says nothing about the session: no hint.
    if (isIgnoredSubagentEvent(receipt.payload)) return;
    const hint = {
      source: "claude_hook" as const,
      worktreePath: (receipt.payload.cwd ?? null) as WorktreePath | null,
      sessionId: receipt.sessionId,
    };
    for (const listener of listeners) listener(hint);
  };

  const receiver: HookReceiver = await startHookReceiver({
    log,
    ...(config.receiver ?? {}),
    onReceipt,
    ...(config.onError ? { onError: config.onError } : {}),
    ...(config.now ? { now: config.now } : {}),
  });

  const settingsRequest = {
    hookBaseUrl: receiver.baseUrl,
    mcpServerName,
    mcpServer: config.mcpServer,
    bashCommandPrefixes: undefined, // Will be set per-run if interactive
  };

  const run = (sessionId: ProviderSessionId): HeadlessRun => {
    const found = headlessRuns.get(sessionId);
    if (!found) throw new Error(`no headless run for session ${sessionId}`);
    return found;
  };

  return {
    hookBaseUrl: receiver.baseUrl,

    listSessions: (): Promise<ClaudeAgentsEntry[]> =>
      readAgents(config.agents ?? {}),

    hookSummary: async (
      sessionId: ProviderSessionId,
    ): Promise<ClaudeHookSummary> =>
      foldHookSummary(await log.bySession(sessionId)),

    writeSettings: async (
      settingsPath: string,
      mcpServer?: McpServerEntry,
      bashCommandPrefixes?: string[],
    ): Promise<void> => {
      await writeSettingsFiles(settingsPath, {
        ...settingsRequest,
        mcpServer: mcpServer ?? config.mcpServer,
        bashCommandPrefixes,
      });
    },

    interactiveArgs: ({ sessionId, resume, model, settingsPath }) => [
      "--settings",
      settingsPath,
      "--mcp-config",
      mcpConfigPathFor(settingsPath),
      resume ? "--resume" : "--session-id",
      sessionId,
      "--model",
      model,
      "--permission-mode",
      "acceptEdits",
    ],

    startHeadless: async (request: StartHeadlessRequest): Promise<void> => {
      headlessRuns.get(request.sessionId)?.close();
      // The run's own registration lives beside its settings file, so a headless run carries the
      // same per-run token an interactive one does. The adapter default is only a fallback.
      const servers =
        (await readMcpConfig(mcpConfigPathFor(request.settingsPath)))
          ?.mcpServers ?? {};
      headlessRuns.set(
        request.sessionId,
        new HeadlessRun(
          request,
          Object.keys(servers).length
            ? servers
            : { [mcpServerName]: config.mcpServer },
        ),
      );
    },

    sendHeadless: async ({ sessionId, text }): Promise<void> => {
      run(sessionId).send(text);
    },

    interruptHeadless: async (sessionId: ProviderSessionId): Promise<void> => {
      await run(sessionId).interrupt();
    },

    headlessState: async (
      sessionId: ProviderSessionId,
    ): Promise<ClaudeSessionObservation["headless"]> =>
      headlessRuns.get(sessionId)?.state ?? null,

    resumable: (sessionId: ProviderSessionId, cwd: WorktreePath | null) =>
      isResumable(sessionId, cwd ?? undefined),

    activityAt: async (sessionId: ProviderSessionId): Promise<IsoTime | null> =>
      foldHookSummary(await log.bySession(sessionId)).lastEventAt,

    subscribe: (onHint: OnHint): Unsubscribe => {
      listeners.add(onHint);
      return () => listeners.delete(onHint);
    },

    close: async (): Promise<void> => {
      listeners.clear();
      for (const headless of headlessRuns.values()) headless.close();
      headlessRuns.clear();
      await receiver.close();
    },
  };
}
