import type { Context } from "./context.js";
import type { Run } from "./entities.js";
import { later, read, runId } from "./helpers.js";
import type { RunId, WorktreePath } from "./ids.js";
import { deriveStatus } from "./status.js";

export function observeRuns(c: Context): void {
  // Enforce terminal-task invariant: end all external runs on done/canceled tasks
  if (c.task.stage === "done" || c.task.stage === "canceled") {
    const endReason =
      c.task.stage === "done" ? "task_done" : ("canceled" as const);
    for (const run of c.state.runs) {
      if (run.origin === "external" && !run.endedAt) {
        c.end(run, endReason);
      }
    }
  }
  for (const run of c.state.runs) {
    if (run.endedAt || run.origin === "external") continue;
    // A launch result must be committed before old snapshots can describe this attempt.
    if (
      !run.launchedAt &&
      c.state.outbox.some(
        (row) =>
          row.action?.kind === "start_run" &&
          row.action.runId === run.id &&
          row.action.attempt === run.attempts &&
          (row.status === "pending" || row.status === "running"),
      )
    )
      continue;
    const observation = c.observations.runs.find((o) => o.runId === run.id);
    // Ignore snapshots taken before a new launch was requested.
    if (
      run.launchedAt &&
      observation &&
      observation.provider.at < run.launchedAt
    )
      continue;
    const derived = deriveStatus(run, observation);
    const provider = read(observation?.provider);
    const previousStatus = run.status;
    run.status = derived.status;
    run.blockedOn = derived.blockedOn;
    if (
      run.launchedAt &&
      (derived.status === "working" || derived.status === "idle")
    )
      run.retryAt = null;
    if (provider && derived.status !== "unknown") {
      if (provider.provider === "codex") {
        run.seenAt ??= c.now;
        run.codexGeneration = provider.generation;
        delete run.pendingDialog;
        run.pendingRequests = provider.pendingRequests.map((r) => ({
          id: r.requestId,
          generation: provider.generation,
          kind: r.kind,
          blocking: r.isBlocking,
          summary: r.summary,
          receivedAt: r.receivedAt,
        }));
        // Only a fresh, hydrated reading can retire requests. IDs are opaque and may
        // coexist: a newer ID does not supersede an older one that is still pending.
        for (const row of c.state.outbox) {
          const action = row.action;
          if (
            action?.kind !== "answer_provider_request" ||
            action.runId !== run.id
          )
            continue;
          // Repair answers persisted before each request became independent.
          if (row.status === "pending") row.dependsOn = [];
          if (
            !(
              row.status === "pending" ||
              row.status === "running" ||
              (row.status === "failed" && row.retryAt)
            ) ||
            (action.generation === provider.generation &&
              provider.pendingRequests.some(
                (r) => r.requestId === action.requestId,
              ))
          )
            continue;
          row.status = "canceled";
          row.finishedAt ??= c.now;
          row.retryAt = undefined;
        }
        const turn = provider.turns.at(-1);
        if (turn)
          run.lastTurn = {
            id: turn.id,
            outcome: turn.status === "inProgress" ? null : turn.status,
            error: turn.error?.message ?? null,
          };
      } else {
        if (provider.agentsEntry || provider.hooks.sessionStart)
          run.seenAt ??= c.now;
        run.pendingRequests = [];
        if (
          provider.agentsEntry?.status === "waiting" &&
          provider.hooks.pendingDialog
        )
          run.pendingDialog = { ...provider.hooks.pendingDialog };
        else delete run.pendingDialog;
        if (provider.hooks.lastStop)
          run.lastTurn = {
            id: provider.hooks.lastStop.promptId,
            outcome: "completed",
            error: null,
          };
      }
      const activity =
        observation?.activityAt ??
        (provider.provider === "claude" ? provider.hooks.lastEventAt : null);
      if (activity && (!run.lastActivityAt || activity > run.lastActivityAt))
        run.lastActivityAt = activity;
    }
    if (run.status === "idle") {
      run.idleSince =
        previousStatus === "idle"
          ? (run.idleSince ?? run.lastActivityAt ?? run.launchedAt ?? c.now)
          : c.now;
      // A turn can start and stop between polls. Native activity starts a fresh grace period.
      if (run.lastActivityAt && run.lastActivityAt > run.idleSince)
        run.idleSince = run.lastActivityAt;
    } else run.idleSince = null;
    if (run.status === "unknown") {
      run.unknownSince ??= c.now;
      delete run.pendingDialog;
      run.pendingRequests = [];
    } else run.unknownSince = null;
    if (derived.status === "ended")
      c.end(run, derived.endReason ?? "submitted");
    if (derived.nonRetryable)
      c.fail(
        "non_retryable_error",
        "Provider reported a non-retryable error",
        run.id,
      );
    if (
      derived.status === "failed" &&
      !run.retryAt &&
      run.observedAttempt !== run.attempts
    ) {
      if (run.mode === "interactive") {
        c.end(run, "vanished");
        continue;
      }
      if (
        run.attempts - (run.retryBaseAttempt ?? 0) >=
        c.state.config.retry.maxAttempts
      )
        c.fail("retries_exhausted", "Run exhausted its retry attempts", run.id);
      else if (!c.task.blocked && !c.task.failed) {
        run.observedAttempt = run.attempts;
        run.retryAt = later(
          c.now,
          Math.min(
            c.state.config.retry.baseMs *
              2 ** (run.attempts - (run.retryBaseAttempt ?? 0) - 1),
            c.state.config.retry.capMs,
          ),
        );
        c.emit(`schedule:${c.task.id}:retry:${run.retryAt}`, {
          kind: "schedule",
          at: run.retryAt,
          why: "retry",
        });
      }
    }
  }
  // End external runs whose sessions have disappeared, but only if read was successful.
  // On read failure (transient errors), preserve unknown state and don't end runs.
  if (c.observations.externalSessions.ok) {
    const sessions = c.observations.externalSessions.value;
    for (const run of c.state.runs) {
      if (run.origin !== "external" || run.endedAt) continue;
      const stillActive = sessions.some(
        (s) => s.provider === run.provider && s.sessionId === run.sessionId,
      );
      if (!stillActive) {
        c.end(run, "vanished");
      }
    }
  }
  // Only adopt new external sessions if read was successful
  const sessionsToAdopt = c.observations.externalSessions.ok
    ? c.observations.externalSessions.value
    : [];
  for (const session of sessionsToAdopt) {
    if (
      session.cwd !== c.task.worktreePath ||
      c.state.runs.some(
        (r) =>
          r.provider === session.provider && r.sessionId === session.sessionId,
      )
    )
      continue;
    c.state.runs.push({
      id: `${c.task.id}/external/${session.provider}/${session.sessionId}` as RunId,
      taskId: c.task.id,
      role: "implementer",
      provider: session.provider,
      mode: session.kind === "interactive" ? "interactive" : "headless",
      origin: "external",
      worktreePath: session.cwd,
      round: 0,
      attempts: 0,
      model: "",
      sessionId: session.sessionId,
      sessionEpoch: 0,
      codexGeneration: null,
      pane: null,
      status: session.active ? "working" : "idle",
      blockedOn: null,
      lastTurn: null,
      pendingRequests: [],
      lastActivityAt: c.now,
      retryAt: null,
      launchedAt: null,
      endedAt: null,
      endReason: null,
    });
  }
}

function launch(c: Context, run: Run, resume: boolean, fresh = false): void {
  // Legacy ended runs can still carry attempted messages. Retire those before reusing
  // the run ID, while preserving unsent follow-ups queued for this new launch.
  if (run.endedAt)
    for (const message of c.state.messages)
      if (
        message.runId === run.id &&
        (message.status === "sent" ||
          (message.status === "pending" && message.attempts > 0))
      ) {
        message.status = "failed";
        message.deliveryAttention = false;
      }
  const observation = c.observations.runs.find((o) => o.runId === run.id);
  // `resumable: false` only ever comes from a direct owner read (§5.2), so it rotates the session
  // even when the transcript read itself failed: a Codex thread without a rollout can't be read.
  if (fresh || (observation?.resumable === false && run.sessionId)) {
    run.sessionEpoch++;
    run.pane = null;
    run.codexGeneration = null;
    run.sessionId =
      run.provider === "claude"
        ? c.state.config.deriveClaudeSessionId(run.id, run.sessionEpoch)
        : null;
    resume = false;
  }
  c.emit(`start_run:${run.id}#${run.attempts}`, {
    kind: "start_run",
    runId: run.id,
    role: run.role,
    provider: run.provider,
    mode: run.mode,
    worktreePath: run.worktreePath,
    model: run.model,
    ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
    attempt: run.attempts,
    sessionEpoch: run.sessionEpoch,
    sessionId: run.sessionId,
    resume: resume && run.sessionId !== null,
  });
  c.result.capacityVersion = c.observations.capacity.version;
  c.reserved[run.provider]++;
  run.status = "starting";
  run.idleSince = null;
  run.unknownSince = null;
  run.pendingRequests = [];
  delete run.pendingDialog;
  run.lastTurn = null;
  run.seenAt = null;
  run.endedAt = null;
  run.endReason = null;
  run.retryAt = null;
  run.blockedOn = null;
  run.launchedAt = null;
  const pending = c.state.messages.find(
    (m) => m.runId === run.id && m.status === "pending" && m.attempts === 0,
  );
  if (pending) {
    const text = pending.text
      .split("\n")
      .filter((line) => !line.startsWith("Current git observation:"))
      .join("\n");
    pending.text = `Current git observation: ${JSON.stringify(c.git ?? null)}\n${text}`;
    pending.textHash = c.state.config.sha256(pending.text);
  } else
    c.message(
      run,
      "initial",
      run.attempts,
      [
        `You are Loom's ${run.role} for task ${c.task.id}: ${c.task.title}.`,
        "Call the Loom MCP tool `get_task_context` first; it is the only source that stays current.",
        COMPLETION[run.role],
        "Inspect the existing worktree changes, plan, findings and handoff before continuing. Preserve existing work; this may be a fresh session replacing an earlier agent.",
        "Loom moves the task between stages; you never do. Don't merge and don't push to the base branch.",
        `Current git observation: ${JSON.stringify(c.git ?? null)}`,
        `Plan: ${JSON.stringify(c.state.plan ?? null)}`,
      ].join("\n"),
    );
}

/**
 * What "done" means for each role, stated in the first message. The first real run stopped after
 * implementing, with the tree uncommitted and no submission, because nothing had told it the work
 * ends with a tool call.
 */
const COMPLETION: Record<Run["role"], string> = {
  planner:
    "Your work is complete only when `submit_plan` has succeeded. Do not stop before it has.",
  implementer:
    "Implement the plan in this worktree, run the repo's tests, commit on this branch, and call `submit_for_review` with the commit's head SHA, a summary, your test results and a handoff. Your work is complete only when `submit_for_review` has succeeded. Do not stop before it has.",
  reviewer:
    "Review the branch against the plan, run the tests, and call `submit_review` once with every finding and a verdict for each addressed or disputed one. Your work is complete only when `submit_review` has succeeded.",
};

/**
 * Closing is killing (decision 2026-09-13): an interactive run whose role the task no longer
 * needs must not leave a pane open. A planner's pane goes once the plan is settled, a reviewer's
 * once its review round is over, an implementer's once the task has ended. Only the pane closes;
 * the session stays resumable through its recorded ID. The key is stable, so the action is
 * emitted once per attempt however many passes see the same ended run.
 */
export function retireFinishedPanes(c: Context): void {
  const stage = c.task.stage;
  for (const run of c.state.runs) {
    if (
      run.origin !== "loom" ||
      run.mode !== "interactive" ||
      !run.pane ||
      run.status !== "ended"
    )
      continue;
    const needed =
      run.role === "planner"
        ? stage === "planning" || stage === "plan_approval"
        : run.role === "reviewer"
          ? stage === "in_review"
          : stage !== "done" && stage !== "canceled" && stage !== "backlog";
    if (needed) continue;
    c.emit(`stop_run:${run.id}#${run.attempts}:retire`, {
      kind: "stop_run",
      runId: run.id,
      retire: true,
    });
  }
}

export function startDesired(c: Context): void {
  if (
    c.task.blocked ||
    c.task.failed ||
    ["done", "canceled", "backlog"].includes(c.task.stage)
  )
    return;
  const desired = c.state.desiredRun;
  if (desired) {
    if (!c.state.worktree) {
      const slug =
        c.task.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "task";
      const branch = c.task.branch ?? `loom/${c.task.id}-${slug}`;
      c.emit(`create_worktree:${c.task.id}`, {
        kind: "create_worktree",
        repoId: c.task.repoId,
        path: `${c.state.config.worktreeRoot}/${c.task.id}`,
        branch,
        baseBranch: c.state.config.baseBranch,
      });
      return;
    }
    if (!c.state.worktree.paneWorkspaceId)
      c.emit(`open_workspace:${c.task.id}`, {
        kind: "open_workspace",
        worktreePath: c.state.worktree.path,
        label: c.task.title,
      });
    c.files();
    const replacement = desired.replacement;
    if (replacement) {
      // Retirement must finish before a fresh agent can touch the same worktree, even
      // when capacity or a coordinator restart separates the two reconciliations.
      let stop = c.state.outbox.find(
        (row) =>
          row.action?.kind === "stop_run" &&
          row.action.terminate &&
          row.action.runId === replacement.previousRunId,
      );
      while (stop?.retriedBy)
        stop = c.state.outbox.find((row) => row.key === stop?.retriedBy);
      if (stop?.status !== "succeeded") return;
      if (
        !c.git?.exists ||
        c.git.path !== c.state.worktree.path ||
        c.git.branch !== c.task.branch
      )
        return;
    }
    let run = replacement
      ? c.state.runs.find((r) => r.id === replacement.runId)
      : c.state.runs
          .filter(
            (r) =>
              r.origin === "loom" &&
              r.role === desired.role &&
              r.round === desired.round,
          )
          .at(-1);
    const providerOverride = c.state.config.providerOverrides?.[desired.role];
    if (desired.fresh && run) {
      const stopKey = `stop_run:${run.id}#${run.attempts}:terminate`;
      let stop = c.state.outbox.find((row) => row.key === stopKey);
      while (stop?.retriedBy)
        stop = c.state.outbox.find((row) => row.key === stop?.retriedBy);
      if (stop?.status !== "succeeded") return;
    }
    if (
      !run &&
      !replacement &&
      providerOverride &&
      c.task.providers[desired.role] !== providerOverride
    ) {
      c.change(
        `Applied ${desired.role} provider setting: ${providerOverride}`,
        () => {
          c.task.providers[desired.role] = providerOverride;
        },
      );
    }
    if (run && !run.endedAt) {
      c.state.desiredRun = null;
    } else if (c.capacity(desired.role)) {
      if (!run) {
        const id =
            replacement?.runId ?? runId(c.task.id, desired.role, desired.round),
          provider = replacement?.provider ?? c.task.providers[desired.role];
        const reasoningEffort = replacement
          ? replacement.reasoningEffort
          : provider === "codex"
            ? c.state.config.codexReasoningEffort
            : undefined;
        run = {
          id,
          taskId: c.task.id,
          role: desired.role,
          provider,
          mode: c.state.config.runModes[desired.role] ?? "interactive",
          origin: "loom",
          worktreePath: c.state.worktree.path as WorktreePath,
          round: desired.round,
          attempts: 1,
          model: replacement?.model ?? c.state.config.models[provider],
          ...(reasoningEffort ? { reasoningEffort } : {}),
          sessionId:
            provider === "claude"
              ? c.state.config.deriveClaudeSessionId(id, 0)
              : null,
          sessionEpoch: 0,
          codexGeneration: null,
          pane: null,
          status: "starting",
          blockedOn: null,
          lastTurn: null,
          pendingRequests: [],
          lastActivityAt: null,
          retryAt: null,
          launchedAt: null,
          endedAt: null,
          endReason: null,
        };
        c.state.runs.push(run);
      } else run.attempts++;
      launch(c, run, desired.resume && run.attempts > 1, desired.fresh);
      c.state.desiredRun = null;
    }
  }
  for (const run of c.state.runs) {
    if (
      run.origin !== "loom" ||
      run.mode === "interactive" ||
      !run.retryAt ||
      run.retryAt > c.now ||
      !c.capacity(run.role)
    )
      continue;
    const observation = c.observations.runs.find((o) => o.runId === run.id);
    // A retry needs a successful read, or the owner's word that the session is gone.
    if (!observation?.provider.ok && observation?.resumable !== false) continue;
    if (!c.git?.exists) {
      c.emit(`refresh:retry:${run.id}#${run.attempts}`, {
        kind: "refresh",
        owner: "git",
      });
      continue;
    }
    run.attempts++;
    launch(c, run, true);
  }
}
