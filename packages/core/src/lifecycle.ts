import type { Context } from "./context.js";
import type { Run } from "./entities.js";
import { later, read, runId } from "./helpers.js";
import type { RunId, Sha, WorktreePath } from "./ids.js";
import type {
  ClaudeSessionObservation,
  CodexThreadObservation,
} from "./observations.js";
import { deriveStatus } from "./status.js";

export function inFlightTurnId(
  provider: CodexThreadObservation | ClaudeSessionObservation,
): string | null {
  if (provider.provider === "codex") {
    const turn = provider.turns.at(-1);
    return turn?.status === "inProgress" ? turn.id : null;
  }
  const prompt = provider.hooks.promptSubmits.at(-1);
  return prompt &&
    !provider.hooks.sessionEnd &&
    provider.hooks.lastStop?.promptId !== prompt.promptId
    ? prompt.promptId
    : null;
}

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
    if (run.origin === "external") continue;
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
    if (observation?.tokenUsage && run.sessionId) {
      const tokenUsage = run.tokenUsage ?? [];
      const next = {
        sessionId: run.sessionId,
        counts: { ...observation.tokenUsage },
        observedAt: c.now,
      };
      const existing = tokenUsage.findIndex(
        (entry) => entry.sessionId === run.sessionId,
      );
      if (existing === -1) tokenUsage.push(next);
      else {
        const previous = tokenUsage[existing]?.counts;
        if (
          !previous ||
          previous.input !== next.counts.input ||
          previous.cachedInput !== next.counts.cachedInput ||
          previous.output !== next.counts.output ||
          previous.reasoning !== next.counts.reasoning
        )
          tokenUsage[existing] = next;
      }
      run.tokenUsage = tokenUsage;
    }
    if (run.endedAt) continue;
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
        run.inFlightTurnId = inFlightTurnId(provider);
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
        run.inFlightTurnId = inFlightTurnId(provider);
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
      // Migration 11 and each status transition establish the idle interval.
      if (previousStatus !== "idle") run.idleSince = c.now;
      // A turn can start and stop between polls. Native activity starts a fresh grace period.
      if (
        run.lastActivityAt &&
        run.idleSince &&
        run.lastActivityAt > run.idleSince
      )
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
      access: "full",
      idleSince: session.active ? null : c.now,
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
    access: run.access,
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
        "Call the Loom MCP tool `get_task_context` first. The first call returns the full role view. Call it again only when told state changed; later calls return the changes and anything you must act on. Use `{ full: true }` to reread everything.",
        ...(run.role === "implementer" && run.round > 0
          ? [
              `This is fresh implementer fix-round session ${run.round}; the current diff, reason and findings are in get_task_context, not in a previous transcript.`,
            ]
          : []),
        COMPLETION[run.role],
        "Inspect the existing worktree changes, plan, findings and handoff before continuing. Preserve existing work; this may be a fresh session replacing an earlier agent.",
        "Loom moves the task between stages; you never do. Don't merge and don't push to the base branch.",
        "Be economical: call `report_progress` only when a decision changes course, at most once per plan step. If a Loom tool fails twice in a row with the same error, stop retrying, say so, and end your turn; Loom notices an idle run and brings in the human.",
        `Current git observation: ${JSON.stringify(c.git ?? null)}`,
        `Plan: ${JSON.stringify(c.state.plan ?? null)}`,
      ].join("\n"),
    );
}

/**
 * What "done" means for each role, stated in the first message. The first real run stopped after
 * implementing, with the tree uncommitted and no submission, because nothing had told it the work
 * ends with a tool call. How to do the work, including which checks to run, is the role brief's
 * (apps/coordinator/src/prompts.ts); this only says how the work ends.
 */
const COMPLETION: Record<Run["role"], string> = {
  planner:
    "Your work is complete only when `submit_plan` has succeeded. Do not stop before it has.",
  implementer:
    "Commit on this branch and call `submit_for_review` with the commit's head SHA, a summary, the tests you ran and a handoff. Your work is complete only when `submit_for_review` has succeeded. Do not stop before it has.",
  reviewer:
    "Call `submit_review` once with every finding and a verdict for each addressed or disputed one. Your work is complete only when `submit_review` has succeeded.",
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
    if (!c.state.worktree || c.state.worktree.removedAt !== null) {
      const requiredCommits = c.task.blockedBy.map(
        (taskId) =>
          c.observations.dependencies.find(
            (dependency) => dependency.taskId === taskId,
          )?.mergeCommitSha ?? null,
      );
      if (requiredCommits.some((commit) => commit === null)) return;
      const slug =
        c.task.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "task";
      const branch = c.task.branch ?? `loom/${c.task.id}-${slug}`;
      const generation = c.state.worktree?.removedAt;
      c.emit(
        generation
          ? `create_worktree:${c.task.id}:${generation}`
          : `create_worktree:${c.task.id}`,
        {
          kind: "create_worktree",
          repoId: c.task.repoId,
          path: `${c.state.config.worktreeRoot}/${c.task.id}`,
          branch,
          baseBranch: c.state.config.baseBranch,
          requiredCommits: requiredCommits as Sha[],
        },
      );
      return;
    }
    if (!c.state.worktree.paneWorkspaceId)
      c.emit(`open_workspace:${c.task.id}`, {
        kind: "open_workspace",
        worktreePath: c.state.worktree.path,
        label: c.task.title,
      });
    c.files();
    if (desired.retireRunId) {
      // Fix rounds replace the implementer structurally, just like restart_run: the old
      // provider process must be confirmed gone before a new one touches the worktree.
      let stop = c.state.outbox.find(
        (row) =>
          row.action?.kind === "stop_run" &&
          row.action.terminate &&
          row.action.runId === desired.retireRunId,
      );
      while (stop?.retriedBy)
        stop = c.state.outbox.find((row) => row.key === stop?.retriedBy);
      if (stop?.status !== "succeeded") return;
    }
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
    const roleProfile =
      c.task.roleProfiles?.[desired.role] ??
      c.state.config.roleProfiles?.[desired.role];
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
            ? (roleProfile?.reasoningEffort ??
              c.state.config.codexReasoningEffort)
            : undefined;
        run = {
          id,
          taskId: c.task.id,
          role: desired.role,
          provider,
          mode:
            replacement?.mode ??
            roleProfile?.runMode ??
            c.state.config.runModes[desired.role] ??
            "interactive",
          origin: "loom",
          worktreePath: c.state.worktree.path as WorktreePath,
          round: desired.round,
          attempts: 1,
          model:
            replacement?.model ??
            roleProfile?.model ??
            c.state.config.models[provider],
          ...(reasoningEffort ? { reasoningEffort } : {}),
          access: replacement?.access ?? roleProfile?.access ?? "full",
          ...(desired.fixReason ? { fixReason: desired.fixReason } : {}),
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
          idleSince: null,
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

/** A finished generation is removed only after the pane-retirement actions emitted this pass. */
export function removeFinishedWorktree(c: Context): void {
  if (
    !["done", "canceled"].includes(c.task.stage) ||
    !c.state.worktree ||
    c.state.worktree.removedAt !== null
  )
    return;
  c.emit(`remove_worktree:${c.task.id}:${c.state.worktree.createdAt}`, {
    kind: "remove_worktree",
    repoId: c.task.repoId,
    worktreePath: c.state.worktree.path,
    branch: c.state.worktree.branch,
  });
}
