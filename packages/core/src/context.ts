import type { Action } from "./actions.js";
import type {
  ApprovalVoidReason,
  ArtifactKind,
  BlockedReason,
  Finding,
  MessagePurpose,
  Role,
  Run,
  RunEndReason,
  Stage,
  TransitionTrigger,
} from "./entities.js";
import {
  clone,
  messageId,
  normalizeText,
  openBlocking,
  read,
} from "./helpers.js";
import type {
  ActionKey,
  ApprovalId,
  ArtifactId,
  RunId,
  Sha,
  TransitionId,
} from "./ids.js";
import type { Observations } from "./observations.js";
import type { ReconcileResult, TaskState } from "./reconcile.js";

/** Cleanup intents: never canceled with the work around them, and never held back by it. */
export const CLEANUP_KINDS: readonly string[] = [
  "stop_run",
  "remove_worktree",
  "interrupt_run",
  "disable_auto_merge",
  "notify",
  "refresh",
  "schedule",
];

type ActionData = Action extends infer A
  ? A extends Action
    ? Omit<A, "key" | "taskId">
    : never
  : never;
export class Context {
  result: ReconcileResult;
  trigger: TransitionTrigger = { kind: "reconcile", fact: "observations" };
  reserved = { codex: 0, claude: 0 };
  constructor(
    state: TaskState,
    public observations: Observations,
  ) {
    this.result = {
      next: clone(state),
      actions: [],
      transitions: [],
      inputs: [],
    };
  }
  get state() {
    return this.result.next;
  }
  get task() {
    return this.state.task;
  }
  get now() {
    return this.observations.now;
  }
  get pr() {
    return read(this.observations.github);
  }
  get git() {
    return read(this.observations.git);
  }
  emit(key: string, action: ActionData): ActionKey {
    const baseKey = key;
    let sequence = 1;
    while (
      this.state.outbox.some(
        (row) => row.key === key && row.status === "canceled",
      )
    )
      key = `${baseKey}#${++sequence}`;
    const existing = this.state.outbox.find((row) => row.key === key);
    if (existing) return existing.key;
    const full = {
      ...action,
      key: key as ActionKey,
      taskId: this.task.id,
    } as Action;
    const dependsOn = this.result.actions
      .filter((a) => !["notify", "schedule", "refresh"].includes(a.kind))
      .map((a) => a.key);
    for (const row of this.state.outbox)
      if (
        row.kind === "disable_auto_merge" &&
        (row.status === "pending" || row.status === "running") &&
        !dependsOn.includes(row.key)
      )
        dependsOn.push(row.key);
    this.result.actions.push(full);
    this.state.outbox.push({
      key: full.key,
      dependsOn: [
        "notify",
        "schedule",
        "refresh",
        "disable_auto_merge",
        // Each human answer is independent, including concurrent requests on one run.
        "answer_provider_request",
      ].includes(full.kind)
        ? []
        : dependsOn,
      kind: full.kind,
      action: full,
      status: "pending",
      attempts: 0,
      createdAt: this.now,
      finishedAt: null,
    });
    return full.key;
  }
  /** Internal timers may move without creating a new durable intent identity. */
  reschedule(
    key: string,
    action: Extract<ActionData, { kind: "schedule" }>,
  ): ActionKey {
    const existing = this.state.outbox.find((row) => row.key === key);
    if (!existing) return this.emit(key, action);
    if (
      existing.status === "running" ||
      existing.action?.kind !== "schedule" ||
      existing.action.why !== action.why
    )
      return existing.key;
    if (existing.action.at === action.at) return existing.key;
    const full: Action = {
      ...action,
      key: existing.key,
      taskId: this.task.id,
    } as Action;
    existing.action = full;
    existing.status = "pending";
    existing.attempts = 0;
    existing.finishedAt = null;
    delete existing.error;
    delete existing.retryAt;
    delete existing.retriedBy;
    delete existing.retryBaseAttempt;
    this.result.actions.push(full);
    return existing.key;
  }
  audit(
    from: Stage,
    blocked: BlockedReason | null,
    failed: TaskState["task"]["failed"],
    reason: string,
  ): void {
    const to = this.task.stage;
    const nextBlocked = this.task.blocked?.reason ?? null;
    const nextFailed = this.task.failed?.reason ?? null;
    if (
      from === to &&
      blocked === nextBlocked &&
      failed?.reason === this.task.failed?.reason
    )
      return;
    this.result.transitions.push({
      id: `${this.task.id}/${this.task.version + 1}/${this.result.transitions.length}` as TransitionId,
      taskId: this.task.id,
      at: this.now,
      from,
      to,
      flags: {
        ...(blocked !== nextBlocked
          ? { blocked: { from: blocked, to: nextBlocked } }
          : {}),
        ...(failed?.reason !== this.task.failed?.reason
          ? { failed: { from: failed?.reason ?? null, to: nextFailed } }
          : {}),
      },
      trigger: this.trigger,
      reason,
      taskVersion: this.task.version + 1,
    });
  }
  change(reason: string, mutate: () => void): void {
    const { stage, blocked, failed } = this.task;
    mutate();
    this.audit(stage, blocked?.reason ?? null, failed, reason);
  }
  stage(stage: Stage, reason: string): void {
    this.change(reason, () => {
      this.task.stage = stage;
      this.task.stageEnteredAt = this.now;
    });
  }
  block(
    reason: BlockedReason | null,
    detail = "",
    until: TaskState["task"]["stageEnteredAt"] | null = null,
  ): void {
    if (
      this.task.blocked?.reason === reason &&
      this.task.blocked.until === until
    )
      return;
    this.change(detail || "Clear blocked flag", () => {
      this.task.blocked = reason
        ? { reason, detail, since: this.now, until, questionId: null }
        : null;
    });
  }
  fail(
    reason: NonNullable<TaskState["task"]["failed"]>["reason"],
    detail: string,
    runId: RunId | null = null,
  ): void {
    if (this.task.failed?.reason === reason) return;
    this.change(detail, () => {
      this.task.failed = { reason, detail, runId, since: this.now };
    });
  }
  notify(title: string, identity: string): void {
    this.emit(`notify:${this.task.id}:${identity}`, {
      kind: "notify",
      level: "attention",
      title,
      body: title,
    });
  }
  current(role: Role): Run | undefined {
    return this.state.runs
      .filter((r) => r.origin === "loom" && r.role === role)
      .at(-1);
  }
  capacity(role: Role, releasing?: Run): boolean {
    const p = this.task.providers[role],
      c = this.observations.capacity;
    const until = c.coolingDownUntil[p];
    const release =
      releasing &&
      !releasing.endedAt &&
      ["starting", "working", "blocked"].includes(releasing.status)
        ? 1
        : 0;
    return (
      (!until || until <= this.now) &&
      c.active[p] +
        this.reserved[p] -
        (releasing?.provider === p ? release : 0) <
        c.caps[p] &&
      c.active.codex +
        c.active.claude +
        this.reserved.codex +
        this.reserved.claude -
        release <
        c.caps.total
    );
  }
  requestRun(
    role: Role,
    round = role === "reviewer" ? this.task.reviewRound : 0,
    resume = true,
  ): void {
    this.state.desiredRun = { role, round, resume };
  }
  end(
    run: Run,
    reason: RunEndReason,
    interrupt = false,
    terminate = false,
  ): void {
    if (run.endedAt && !terminate) return;
    // For Loom-launched runs, cancel pending actions and manage capacity.
    // For external runs, skip those steps (they never counted toward capacity).
    if (run.origin === "loom") {
      for (const message of this.state.messages)
        if (
          message.runId === run.id &&
          (message.status === "pending" || message.status === "sent")
        ) {
          message.status = "failed";
          message.deliveryAttention = false;
        }
      for (const row of this.state.outbox)
        if (
          (row.status === "pending" ||
            row.status === "running" ||
            (terminate && row.status === "failed")) &&
          row.action &&
          "runId" in row.action &&
          row.action.runId === run.id &&
          ["start_run", "send_message", "answer_provider_request"].includes(
            row.kind,
          )
        )
          row.status = "canceled";
      this.result.actions = this.result.actions.filter(
        (a) =>
          !this.state.outbox.some(
            (row) => row.key === a.key && row.status === "canceled",
          ),
      );
      if (["starting", "working", "blocked"].includes(run.status))
        this.reserved[run.provider]--;
      if (interrupt && !terminate && run.status === "working")
        this.emit(`interrupt_run:${run.id}#${run.attempts}:${reason}`, {
          kind: "interrupt_run",
          runId: run.id,
          reason,
        });
    }
    // Both Loom and external runs: emit stop_run for headless mode (cleanup)
    // and set end state.
    if (run.mode === "headless" || terminate)
      this.emit(
        `stop_run:${run.id}#${run.attempts}${terminate ? ":terminate" : ""}`,
        {
          kind: "stop_run",
          runId: run.id,
          ...(terminate ? { terminate: true } : {}),
        },
      );
    run.status = "ended";
    run.blockedOn = null;
    run.endedAt = this.now;
    run.endReason = reason;
    run.retryAt = null;
    if (run.origin === "loom")
      this.result.capacityVersion = this.observations.capacity.version;
  }
  voidApprovals(reason: ApprovalVoidReason): void {
    for (const row of this.state.outbox)
      if (
        row.kind === "merge_pr" &&
        (row.status === "pending" || row.status === "running")
      )
        row.status = "canceled";
    if (this.pr?.autoMergeEnabled)
      this.emit(
        `disable_auto_merge:${this.task.id}:${this.pr.headSha}:${this.task.version + 1}`,
        {
          kind: "disable_auto_merge",
          repoId: this.task.repoId,
          prNumber: this.pr.number,
        },
      );
    for (const approval of this.state.approvals)
      if (!approval.voidedAt) {
        approval.voidedAt = this.now;
        approval.voidReason = reason;
      }
  }
  cancelPending(): void {
    for (const row of this.state.outbox)
      if (
        (row.status === "pending" || row.status === "running") &&
        !CLEANUP_KINDS.includes(row.kind)
      )
        row.status = "canceled";
    this.result.actions = this.result.actions.filter(
      (a) =>
        !this.state.outbox.some(
          (row) => row.key === a.key && row.status === "canceled",
        ),
    );
  }
  files(): void {
    if (!this.state.worktree) return;
    const artifacts = this.state.artifacts.map(({ kind, version }) => ({
      kind,
      version,
    }));
    this.emit(
      `write_task_files:${this.task.id}:${this.task.stage}:${artifacts.map((a) => `${a.kind}@${a.version}`).join(",")}`,
      {
        kind: "write_task_files",
        worktreePath: this.state.worktree.path,
        artifacts,
      },
    );
  }
  artifact(kind: ArtifactKind, content: unknown, run?: Run): number {
    const previous = this.state.artifacts.find((a) => a.kind === kind);
    const version = (previous?.version ?? 0) + 1;
    this.state.artifacts = this.state.artifacts.filter((a) => a.kind !== kind);
    this.state.artifacts.push({
      id: `${this.task.id}/${kind}/${version}` as ArtifactId,
      taskId: this.task.id,
      kind,
      version,
      path: `tasks/${this.task.id}/${kind}/v${version}.json`,
      sha256: this.state.config.sha256(JSON.stringify(content)),
      createdBy: run ? { runId: run.id } : "coordinator",
      createdAt: this.now,
    });
    this.state.artifactContents[kind] = clone(content);
    return version;
  }
  message(
    run: Run,
    purpose: MessagePurpose,
    sequence: string | number,
    text: string,
    options: { when?: "now" | "after_turn"; images?: string[] } = {},
  ): void {
    const id = messageId(run.id, purpose, sequence);
    if (this.state.messages.some((m) => m.id === id)) return;
    const normalized = normalizeText(text);
    // Prefix all untrusted text, so slash/bang input never reaches the shell path.
    const safe = /^[/!]/.test(normalized.trimStart())
      ? `Loom message:\n${normalized}`
      : normalized;
    this.state.messages.push({
      id,
      runId: run.id,
      purpose,
      text: safe,
      when: options.when ?? "now",
      images: options.images ?? [],
      textHash: this.state.config.sha256(safe),
      status: "pending",
      pendingSince: this.now,
      attempts: 0,
      transportRef: null,
      sentAt: null,
      delivered: null,
    });
  }
  fix(reason = "Blocking findings require changes"): void {
    this.requestFixRun(reason);
  }
  /** A fix round with no findings: the branch must be rebased onto base before it can merge. */
  rebase(base: string, head: Sha): void {
    this.requestFixRun(
      `The branch conflicts with ${base} at ${head}. Rebase onto ${base} (or merge it in), preserve the reviewed changes, run the tests, and submit again.`,
    );
  }
  private requestFixRun(reason: string): void {
    const run = this.current("implementer");
    const round = (run?.round ?? -1) + 1;
    if (run) this.end(run, "superseded", false, true);
    this.state.desiredRun = {
      role: "implementer",
      round,
      resume: false,
      ...(run ? { retireRunId: run.id } : {}),
      fixReason: reason,
    };
  }
  review(head: Sha): void {
    this.task.reviewRound++;
    this.state.review = {
      headSha: head,
      lastReviewedHead: this.state.review?.lastReviewedHead ?? null,
      previousBlocking: this.state.review?.previousBlocking ?? null,
      verdictIds: this.state.findings
        .filter((f) => f.status === "addressed" || f.status === "disputed")
        .map((f) => f.id),
    };
    this.requestRun("reviewer", this.task.reviewRound, false);
  }
  finding(
    data: Pick<Finding, "id" | "severity" | "title" | "body" | "anchor"> &
      Partial<Finding>,
  ): Finding {
    const finding: Finding = {
      taskId: this.task.id,
      round: this.task.reviewRound,
      source: "reviewer",
      externalId: null,
      createdByRunId: null,
      blocking: data.severity === "blocker" || data.severity === "major",
      status: "open",
      reopenCount: 0,
      location: null,
      resolution: null,
      createdAt: this.now,
      updatedAt: this.now,
      ...data,
    };
    if (!this.state.findings.some((f) => f.id === finding.id))
      this.state.findings.push(finding);
    return finding;
  }
  approval(head?: Sha, approvedBy: "human" | "policy" = "human"): void {
    const id =
      `${this.task.id}/approval/${this.task.version + 1}/${this.result.inputs.length}` as ApprovalId;
    const common = {
      id,
      taskId: this.task.id,
      createdAt: this.now,
      voidedAt: null,
      voidReason: null,
    };
    if (head && this.pr) {
      const findings = this.state.findings
        .map(({ id, status, severity }) => ({ id, status, severity }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      this.state.approvals.push({
        ...common,
        kind: "merge",
        headSha: head,
        ci: clone(this.pr.ci),
        approvedBy,
        findings: {
          findings,
          hash: this.state.config.sha256(JSON.stringify(findings)),
          openBlocking: openBlocking(this.state.findings),
        },
      });
      this.emit(`merge_pr:${id}`, {
        kind: "merge_pr",
        repoId: this.task.repoId,
        prNumber: this.pr.number,
        matchHeadSha: head,
        auto: this.pr.ci.conclusion === "pending",
      });
    } else if (this.state.plan)
      this.state.approvals.push({
        ...common,
        kind: "plan",
        planVersion: this.state.plan.version,
      });
  }
}
