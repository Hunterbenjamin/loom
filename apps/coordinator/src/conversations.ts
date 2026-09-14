import type {
  ConversationItem as CoreItem,
  IsoTime,
  ProviderSessionId,
  Run,
  TaskId,
} from "@loom/core";
import {
  type ConversationTarget,
  conversationKey,
  type Subscription,
} from "@loom/protocol";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import type { LeadSession } from "./lead.js";
import type { Row } from "./views.js";

type Scope = Extract<Subscription, { kind: "conversation" }>;
export interface ConversationViewsDeps {
  store: Store;
  adapters: Adapters;
  lead(repoId: string): LeadSession;
  now(): IsoTime;
  after(ms: number, callback: () => void): () => void;
  deliveryTimeoutMs: number;
  replace(owner: string, rows: Row[]): void;
  log(message: string): void;
}

export class ConversationViews {
  private active = new Map<string, Scope>();
  private timers = new Map<string, () => void>();
  private reads = new Map<string, Promise<void>>();
  private refreshAgain = new Set<string>();
  private loaded = new Set<string>();
  private latest = new Map<string, Parameters<ConversationViews["publish"]>>();
  private stopped = false;
  constructor(private readonly deps: ConversationViewsDeps) {}

  subscriptions(scopes: readonly Subscription[]): void {
    const next = new Map(
      scopes
        .filter((s): s is Scope => s.kind === "conversation")
        .map((s) => [conversationKey(s.target), s]),
    );
    for (const [key, cancel] of this.timers)
      if (!next.has(key)) {
        cancel();
        this.timers.delete(key);
        this.loaded.delete(key);
        this.latest.delete(key);
        this.refreshAgain.delete(key);
        this.deps.replace(`conversation:${key}`, []);
      }
    this.active = next;
    for (const [key, scope] of next)
      if (!this.timers.has(key)) this.schedule(key, scope, 10_000);
  }
  ensure(scopes: readonly Subscription[]): void {
    for (const scope of scopes)
      if (
        scope.kind === "conversation" &&
        !this.loaded.has(conversationKey(scope.target))
      )
        void this.refresh(scope);
  }
  hint(sessionId: string | null): void {
    if (!sessionId) return;
    for (const scope of this.active.values()) {
      const id = this.sessionId(scope.target);
      if (id === sessionId) void this.refresh(scope);
    }
  }
  private sessionId(target: ConversationTarget): string | null {
    if (target.kind === "lead") return this.deps.lead(target.repoId).sessionId;
    for (const task of this.deps.store.tasks()) {
      const run = this.deps.store
        .runs(task.id)
        .find((value) => value.id === target.runId);
      if (run) return run.sessionId;
    }
    return null;
  }
  private schedule(key: string, scope: Scope, ms: number): void {
    if (this.stopped || !this.active.has(key)) return;
    const cancel = this.deps.after(ms, () => {
      this.timers.delete(key);
      void this.refresh(scope).finally(() => {
        if (!this.timers.has(key)) this.schedule(key, scope, 10_000);
      });
    });
    this.timers.set(key, cancel);
  }
  private refresh(scope: Scope): Promise<void> {
    const key = conversationKey(scope.target);
    const pending = this.reads.get(key);
    if (pending) {
      this.refreshAgain.add(key);
      return pending;
    }
    const started = Date.now();
    const read = this.read(scope)
      .catch((error) => {
        this.deps.log(
          `Conversation ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        const previous = this.latest.get(key);
        if (previous)
          this.publish(
            previous[0],
            previous[1],
            previous[2],
            previous[3],
            previous[4],
            previous[5],
            error instanceof Error ? error.message : String(error),
            previous[7],
          );
        else
          this.publish(
            scope.target,
            "claude",
            "unknown",
            [],
            false,
            null,
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        this.reads.delete(key);
        if (this.active.has(key)) this.loaded.add(key);
        this.deps.log(`Conversation ${key} read in ${Date.now() - started}ms`);
        const refreshAgain = this.refreshAgain.delete(key);
        const active = this.active.get(key);
        if (refreshAgain && active) void this.refresh(active);
      });
    this.reads.set(key, read);
    return read;
  }
  private findRun(runId: string): Run | null {
    for (const task of this.deps.store.tasks()) {
      const run = this.deps.store
        .runs(task.id)
        .find((value) => value.id === runId);
      if (run) return run;
    }
    return null;
  }
  private status(
    run: Run,
  ): "working" | "idle" | "waiting" | "stopped" | "unknown" {
    if (run.endedAt) return "stopped";
    if (run.status === "working") return "working";
    if (run.status === "idle") return "idle";
    if (run.status === "blocked") return "waiting";
    return "unknown";
  }
  private async read(scope: Scope): Promise<void> {
    const target = scope.target;
    if (target.kind === "lead") {
      const lead = this.deps.lead(target.repoId);
      const state = await lead.state();
      await lead.flushQueued?.();
      if (!lead.sessionId || !lead.cwd || state.status === "stopped") {
        this.publish(target, "claude", "stopped", [], false, null, null);
        return;
      }
      const hooks = await this.deps.adapters.claude.hookSummary(
        lead.sessionId as ProviderSessionId,
      );
      await this.confirmLead(
        target.repoId,
        lead.sessionId as ProviderSessionId,
        lead.cwd,
        hooks,
      );
      const result = await this.deps.adapters.claude.readConversation({
        sessionId: lead.sessionId as ProviderSessionId,
        cwd: lead.cwd,
        transcriptPath: hooks.transcriptPath,
      });
      this.publish(
        target,
        "claude",
        state.status,
        result.items,
        result.truncated,
        state.status === "waiting" && hooks.pendingDialog
          ? { source: "claude_dialog", ...hooks.pendingDialog }
          : null,
        null,
      );
      return;
    }
    const run = this.findRun(target.runId);
    if (run?.origin !== "loom" || !run.sessionId) {
      this.publish(
        target,
        run?.provider ?? "claude",
        "unknown",
        [],
        false,
        null,
        "Run has no Loom-owned provider session",
      );
      return;
    }
    const prompt =
      run.provider === "claude" && run.pendingDialog
        ? {
            source: "claude_dialog" as const,
            ...run.pendingDialog,
            sessionEpoch: run.sessionEpoch,
          }
        : run.provider === "codex" && run.pendingRequests[0]
          ? {
              source: "codex_request" as const,
              requestId: run.pendingRequests[0].id,
              generation:
                run.pendingRequests[0].generation ?? run.codexGeneration ?? 0,
              kind: run.pendingRequests[0].kind,
              summary: run.pendingRequests[0].summary,
            }
          : null;
    if (run.provider === "codex") {
      const adapter = this.deps.adapters.codexIfRunning(run.taskId as TaskId);
      if (!adapter) {
        this.publish(
          target,
          "codex",
          this.status(run),
          [],
          false,
          prompt,
          "Codex thread is not loaded; open the terminal",
        );
        return;
      }
      const result = await adapter.readConversation(run.sessionId);
      this.publish(
        target,
        "codex",
        this.status(run),
        result.items,
        result.truncated,
        prompt,
        null,
        run,
      );
    } else {
      const hooks = await this.deps.adapters.claude.hookSummary(run.sessionId);
      const result = await this.deps.adapters.claude.readConversation({
        sessionId: run.sessionId,
        cwd: run.worktreePath,
        transcriptPath: hooks.transcriptPath,
      });
      this.publish(
        target,
        "claude",
        this.status(run),
        result.items,
        result.truncated,
        prompt,
        null,
        run,
      );
    }
  }
  private async confirmLead(
    repoId: string,
    sessionId: ProviderSessionId,
    cwd: string,
    hooks: Awaited<ReturnType<Adapters["claude"]["hookSummary"]>>,
  ): Promise<void> {
    for (const message of this.deps.store.leadMessages
      .list(repoId)
      .filter((m) => m.state === "sent" && m.sentAt)) {
      let receipt = hooks.promptSubmits.find(
        (p) =>
          p.textHash === message.textHash && p.at >= (message.sentAt as string),
      );
      receipt ??=
        (await this.deps.adapters.claude.promptReceipt({
          sessionId,
          cwd: cwd as never,
          textHash: message.textHash,
          after: message.sentAt as IsoTime,
          before: this.deps.now(),
        })) ?? undefined;
      if (receipt)
        this.deps.store.leadMessages.update(
          repoId,
          message.id,
          "delivered",
          null,
          receipt.at,
        );
      else if (
        Date.parse(this.deps.now()) - Date.parse(message.sentAt as string) >=
        this.deps.deliveryTimeoutMs
      )
        this.deps.store.leadMessages.update(
          repoId,
          message.id,
          "sent",
          "not confirmed by Claude",
          this.deps.now(),
        );
    }
  }
  private publish(
    target: ConversationTarget,
    provider: "claude" | "codex",
    status: "working" | "idle" | "waiting" | "stopped" | "unknown",
    items: CoreItem[],
    truncated: boolean,
    pendingPrompt: unknown,
    error: string | null,
    run?: Run,
  ): void {
    const key = conversationKey(target);
    if (!this.active.has(key)) return;
    this.latest.set(key, [
      target,
      provider,
      status,
      items,
      truncated,
      pendingPrompt,
      error,
      run,
    ]);
    const sends =
      target.kind === "lead"
        ? this.deps.store.leadMessages.list(target.repoId).map((m) => ({
            id: m.id,
            text: m.text,
            state: m.state,
            at: m.createdAt,
            reason: m.reason,
            when: m.when,
          }))
        : run
          ? this.deps.store
              .messages(run.taskId)
              .filter((m) => m.runId === run.id && m.purpose === "human")
              .slice(-20)
              .map((m) => ({
                id: m.id,
                text: m.text,
                state:
                  m.status === "pending"
                    ? m.attempts
                      ? "sent"
                      : "queued"
                    : m.status,
                at: m.pendingSince ?? m.sentAt ?? this.deps.now(),
                reason:
                  m.deliveryReason ??
                  (m.deliveryAttention ? "Delivery needs attention" : null),
                when: m.when ?? "now",
              }))
          : [];
    this.deps.replace(`conversation:${key}`, [
      {
        collection: "conversation",
        key,
        value: {
          target,
          provider,
          status,
          pendingPrompt,
          sends,
          truncated,
          readAt: this.deps.now(),
          error,
        },
      },
      ...items.map((item, order) => ({
        collection: "conversation_item" as const,
        key: `${key}#${item.id}`,
        value: { conversationKey: key, order, ...item },
      })),
    ]);
    const scope = this.active.get(key);
    if (scope) {
      this.timers.get(key)?.();
      this.timers.delete(key);
      this.schedule(
        key,
        scope,
        status === "working" || status === "waiting" ? 1_500 : 10_000,
      );
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }
}
