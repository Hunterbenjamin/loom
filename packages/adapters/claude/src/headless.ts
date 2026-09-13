// Headless runs over the Agent SDK, in streaming-input mode so a run stays open for follow-up
// messages and can be interrupted. Loom chooses the session ID; retries reuse it with `resume`.

import {
  getSessionInfo,
  type Options,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeSessionObservation,
  ProviderSessionId,
  WorktreePath,
} from "@loom/core";
import type { McpServerEntry } from "./settings.js";

export type HeadlessState = NonNullable<ClaudeSessionObservation["headless"]>;

/** Read-only planner sessions may inspect but cannot use edit tools. */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
] as const;

export interface StartHeadlessRequest {
  sessionId: ProviderSessionId;
  resume: boolean;
  cwd: WorktreePath;
  model: string;
  settingsPath: string;
  readOnly: boolean;
  prompt: string;
}

/** An async iterable the adapter pushes into, so one run can take several messages. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  readonly #queued: SDKUserMessage[] = [];
  readonly #waiting: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  #closed = false;

  push(text: string): void {
    if (this.#closed) throw new Error("headless input is closed");
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#queued.push(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0))
      waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const queued = this.#queued.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>(
        (resolve) => this.#waiting.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

/** One Loom-launched headless run. The process's own exit, which no hook reports. */
export class HeadlessRun {
  readonly #input = new MessageQueue();
  readonly #query: Query;
  #completedTurns = 0;
  #state: HeadlessState = { exited: false, exitCode: null, error: null };

  constructor(
    request: StartHeadlessRequest,
    mcpServers: Record<string, McpServerEntry>,
  ) {
    this.#input.push(request.prompt);
    const options: Options = {
      cwd: request.cwd,
      model: request.model,
      settings: request.settingsPath,
      // Full access inside the run's worktree (user decision, 2026-09-12): a headless run has
      // nobody to answer a prompt, and the read-only roles are still fenced by disallowedTools.
      permissionMode: "bypassPermissions",
      // `sessionId` and `resume` are mutually exclusive: a fresh run names itself, a retry
      // reattaches to the ID Loom already recorded (principle 7).
      ...(request.resume
        ? { resume: request.sessionId }
        : { sessionId: request.sessionId }),
      ...(request.readOnly
        ? { disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS] }
        : {}),
      // Claude Code ignores `mcpServers` in a settings file, so they are passed natively here,
      // and their tools are allowed up front: nobody can grant a permission to a headless run.
      ...(Object.keys(mcpServers).length > 0
        ? {
            mcpServers,
            allowedTools: Object.keys(mcpServers).map((name) => `mcp__${name}`),
          }
        : {}),
    };
    this.#query = query({ prompt: this.#input, options });
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      let lastError: string | null = null;
      for await (const message of this.#query) {
        if (message.type === "result") {
          this.#completedTurns++;
          lastError =
            message.subtype === "success"
              ? null
              : message.errors.join("; ") || message.subtype;
          this.#state.lastTurn = {
            outcome: message.subtype === "success" ? "completed" : "failed",
            error: lastError,
          };
        }
      }
      this.#state = {
        ...this.#state,
        exited: true,
        exitCode: 0,
        error: lastError,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        exited: true,
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  get state(): HeadlessState {
    return { ...this.#state, completedTurns: this.#completedTurns };
  }

  send(text: string): void {
    this.#input.push(text);
  }

  async interrupt(): Promise<void> {
    await this.#query.interrupt();
  }

  /** Ends the run: closes the input stream and terminates the CLI subprocess. */
  close(): void {
    this.#input.close();
    this.#query.close();
  }
}

/**
 * The design's `resumable`: a provider-confirmed check, not an inference from a failed read.
 * `getSessionInfo` reads that one transcript and returns undefined when it is missing, is a
 * sidechain, or doesn't parse.
 */
export async function isResumable(
  sessionId: ProviderSessionId,
  cwd?: WorktreePath,
): Promise<boolean> {
  try {
    const info = await getSessionInfo(sessionId, cwd ? { dir: cwd } : {});
    return info !== undefined;
  } catch {
    return false;
  }
}
