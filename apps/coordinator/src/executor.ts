import { isStaleEntry } from "@loom/adapter-claude";
import { StaleCodexRequestError } from "@loom/adapter-codex";
import { GitHubError } from "@loom/adapter-github";
import { type PullRequestCommand, pullRequestDetail } from "@loom/protocol";
import { observeRun } from "./observe.js";
// The executor (brief §2). It claims outbox rows, rechecks the claim immediately before any side
// effect, maps every `Action` kind to the adapter that owns it, and records the outcome with
// `store.outbox.finish` as an `action_result` input for the next pass.
//
// Actions run at least once (design §5.4), so every executor checks the owner first: an existing
// worktree, an existing PR, a live session under that ID, a remote head already at the SHA.

import type {
  Action,
  ActionError,
  ActionOutputs,
  ActionResult,
  ArtifactKind,
  Finding,
  InputId,
  IsoTime,
  Repo,
  RepoId,
  Sha,
  TaskId,
  TaskState,
} from "@loom/core";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import { checkPanePromptGate, checkSendGate } from "./gate.js";
import { type LaunchDeps, startRun } from "./launch.js";
import { indexChanges, mapFindings } from "./mapping.js";
import type { PullRequestCache } from "./observe.js";

/** The world moved on: re-read and decide again. Never a retry of the same intent. */
export class PreconditionFailed extends Error {}
/** Don't retry; the task is flagged failed. */
export class Fatal extends Error {}

export const classify = (error: unknown): ActionError => {
  if (error instanceof GitHubError)
    return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof PreconditionFailed ||
    error instanceof StaleCodexRequestError
  )
    return { code: "precondition", message };
  if (error instanceof Fatal) return { code: "fatal", message };
  return { code: "retryable", message };
};

/** The `.task/` files an artifact kind becomes. Text stays text; everything else is JSON. */
const FILE_NAMES: Record<ArtifactKind, string> = {
  brief: "brief.md",
  plan: "plan.json",
  decisions: "decisions.md",
  findings: "findings.json",
  test_results: "test_results.json",
  handoff: "handoff.json",
};

export interface ExecutorDeps {
  store: Store;
  adapters: Adapters;
  config: CoordinatorConfig;
  launch: LaunchDeps;
  pullRequests: PullRequestCache;
  repo(taskId: TaskId): Repo;
  repoById(repoId: RepoId): Repo;
  /** Enqueue `reconcile(taskId)` at a time, for a `schedule` action. */
  schedule(taskId: TaskId, at: string, why: string): void;
  notify(level: "info" | "attention", title: string, body: string): void;
  now(): string;
  nextInputId(): InputId;
  /** Called after each recorded result, so the loop picks the input up. */
  onResult(taskId: TaskId): void;
}

export class Executor {
  private draining: Promise<number> | null = null;
  constructor(private readonly deps: ExecutorDeps) {}

  /** Repository actions have no task/outbox identity; execute once and re-read before retry. */
  async pullRequest(command: PullRequestCommand): Promise<void> {
    const repo = this.deps.repoById(command.repoId);
    if (command.kind === "refresh_pull_requests") return;
    const github = this.deps.adapters.github;
    const pr = pullRequestDetail.parse(
      await github.readPullRequest(repo.github, command.number),
    );
    switch (command.kind) {
      case "merge_pull_request":
        if (pr.headSha !== command.matchHeadSha)
          throw new PreconditionFailed(
            "PR head changed; refresh and confirm the new head SHA",
          );
        if (
          pr.state !== "merged" &&
          (pr.state !== "open" ||
            pr.draft ||
            pr.mergeable !== "mergeable" ||
            !["success", "none"].includes(pr.checks))
        )
          throw new PreconditionFailed(
            "PR must be open, ready, mergeable and have no pending or failed checks",
          );
        await github.mergePullRequest({
          repo: repo.github,
          number: command.number,
          matchHeadSha: command.matchHeadSha,
          deleteBranch: command.deleteBranch,
          auto: false,
        });
        return;
      case "close_pull_request":
        await github.closePullRequest(repo.github, command.number);
        return;
      case "delete_branch":
        if (
          pr.state === "open" ||
          pr.head === pr.base ||
          pr.head === repo.baseBranch
        )
          throw new PreconditionFailed(
            "Only a merged or closed PR's non-base branch can be deleted",
          );
        await github.deleteBranch(repo.github, pr.head);
        return;
    }
  }

  /** Runs every claimable row, one at a time, until none is left. Safe to call concurrently. */
  drain(): Promise<number> {
    if (this.draining) return this.draining;
    const work = this.loop().finally(() => {
      this.draining = null;
    });
    this.draining = work;
    return work;
  }

  private async loop(): Promise<number> {
    let done = 0;
    for (;;) {
      const claim = this.deps.store.outbox.claim(this.deps.now() as never);
      if (!claim) return done;
      await this.execute(claim.key, claim.claimVersion, claim.action);
      done++;
    }
  }

  private async execute(
    key: Action["key"],
    claimVersion: number,
    action: Action | undefined,
  ): Promise<void> {
    const { store } = this.deps;
    if (!action) {
      // A receipt row with no payload cannot be routed; leaving it claimed would stall the task.
      store.outbox.requeue(key, claimVersion);
      return;
    }
    let result: ActionResult;
    try {
      // Cancellation can race an action that is already claimed; never act on a superseded row.
      if (!store.outbox.isClaimCurrent(key, claimVersion)) return;
      const output = await this.perform(action);
      result = { kind: action.kind, ok: true, output } as ActionResult;
    } catch (error) {
      result = {
        kind: action.kind,
        ok: false,
        error: classify(error),
      } as ActionResult;
    }
    store.outbox.finish(key, claimVersion, {
      id: this.deps.nextInputId(),
      receivedAt: this.deps.now() as never,
      type: "action_result",
      key,
      result,
    });
    this.deps.onResult(action.taskId);
  }

  /** One action against its owner. Throws `PreconditionFailed` or `Fatal` to classify a failure. */
  private async perform(action: Action): Promise<unknown> {
    const { adapters, store } = this.deps;
    const state = store.loadTaskState(action.taskId);
    if (
      (action.kind === "push_branch" && action.key.startsWith("rescue:")) ||
      (action.kind === "open_pr" && action.rescueHeadSha)
    ) {
      const expected =
        action.kind === "push_branch"
          ? action.expectedHeadSha
          : action.rescueHeadSha;
      const worktree = state.worktree;
      if (
        state.task.stage !== "in_progress" ||
        !worktree ||
        state.review ||
        state.runs.some(
          (r) =>
            !r.endedAt ||
            (r.role === "implementer" && r.endReason === "submitted"),
        ) ||
        !state.runs.some((r) => r.endReason === "vanished")
      )
        throw new PreconditionFailed("Rescue owner state changed");
      const git = await adapters.git.readWorktree(
        worktree.path,
        worktree.baseBranch,
      );
      if (
        !git.exists ||
        git.path !== worktree.path ||
        git.branch !== state.task.branch ||
        git.branch !== action.branch ||
        git.headSha !== expected ||
        git.dirty ||
        git.aheadOfBase < 1 ||
        (action.kind === "open_pr" && git.remoteHeadSha !== expected)
      )
        throw new PreconditionFailed(
          "Rescue branch or HEAD changed; human inspection required",
        );
    }
    switch (action.kind) {
      case "create_worktree": {
        const repo = this.deps.repoById(action.repoId);
        return adapters.git.createWorktree({
          repoRoot: repo.root,
          path: action.path,
          branch: action.branch,
          baseBranch: action.baseBranch,
        });
      }
      case "write_task_files": {
        const files = action.artifacts.map(({ kind, version }) => {
          const { content } = store.artifact(action.taskId, kind, version);
          return {
            name: FILE_NAMES[kind],
            content:
              typeof content === "string"
                ? content
                : `${JSON.stringify(content, null, 2)}\n`,
          };
        });
        await adapters.git.writeTaskFiles(action.worktreePath, files);
        return {};
      }
      case "open_workspace":
        return adapters.paneHost.ensureWorkspace({
          taskId: action.taskId,
          cwd: action.worktreePath,
          label: action.label,
        });
      case "start_run":
        return startRun(this.deps.launch, action, state);
      case "send_message":
        return this.send(action, state);
      case "interrupt_run":
        return this.interrupt(action, state);
      case "answer_pane_prompt":
        return this.answerPanePrompt(action, state);
      case "answer_provider_request": {
        const run = this.run(state, action.runId);
        if (!run.sessionId)
          throw new PreconditionFailed("The run has no recorded session");
        const codex = await adapters.codex(action.taskId);
        const generation = action.generation ?? codex.generation();
        if (generation === null || generation !== codex.generation())
          throw new PreconditionFailed(
            "The app-server generation changed; request IDs restart with the server",
          );
        await codex.answerRequest({
          threadId: run.sessionId,
          generation,
          requestId: action.requestId,
          decision: action.decision,
          answers: action.answers,
        });
        return {};
      }
      case "stop_run": {
        const run = this.run(state, action.runId);
        if (action.terminate) {
          if (run.origin !== "loom" || run.endReason !== "superseded")
            throw new Fatal(
              "Only a superseded Loom run can be retired for replacement",
            );
          if (run.sessionId && run.provider === "codex") {
            const codex = await adapters.codex(action.taskId);
            const sessionId = run.sessionId;
            const read = async () => {
              try {
                return await codex.readThread(sessionId);
              } catch (error) {
                if ((await codex.checkResumable(sessionId)) === false)
                  return null;
                throw error;
              }
            };
            let observation = await read();
            const turn = observation?.turns.at(-1);
            if (turn?.status === "inProgress") {
              await codex.interruptTurn({
                threadId: run.sessionId,
                turnId: turn.id,
              });
              observation = await read();
            }
            if (
              observation?.status === "active" ||
              observation?.turns.at(-1)?.status === "inProgress"
            )
              throw new Error(
                "Waiting for the previous Codex turn to stop before replacement",
              );
            if (observation) await codex.unsubscribe(run.sessionId);
          } else if (run.sessionId && run.mode === "headless") {
            await adapters.claude.closeHeadless(run.sessionId);
            const entry = (await adapters.claude.listSessions()).find(
              (s) => s.sessionId === run.sessionId,
            );
            if (entry && !isStaleEntry(entry))
              throw new Error(
                "Waiting for the previous Claude process to exit before replacement",
              );
          }
          if (run.pane) await adapters.paneHost.closePane(run.pane);
          else if (
            run.sessionId &&
            run.provider === "claude" &&
            run.mode === "interactive"
          ) {
            const observed = await observeRun(adapters, this.deps.now(), run);
            if (
              !observed.provider.ok ||
              (observed.provider.value?.provider === "claude" &&
                observed.provider.value.agentsEntry)
            )
              throw new Error(
                "Cannot retire a live Claude session without its recorded pane",
              );
          }
          return {};
        }
        if (!run.sessionId) return {};
        if (run.provider === "codex")
          await (await adapters.codex(action.taskId)).unsubscribe(
            run.sessionId,
          );
        else if (run.mode === "headless") {
          // Closing terminates the subprocess directly; an interrupt RPC can hang after exit.
          // Let failures reach the outbox so cleanup can be retried.
          await adapters.claude.closeHeadless(run.sessionId);
        }
        return {};
      }
      case "push_branch": {
        // The remote may already be at this SHA, from an earlier attempt of the same intent.
        const observation = await adapters.git.readWorktree(
          action.worktreePath,
          this.deps.config.baseBranch,
        );
        if (observation.remoteHeadSha === action.expectedHeadSha)
          return { remoteHeadSha: action.expectedHeadSha };
        return adapters.git.push({
          worktreePath: action.worktreePath,
          branch: action.branch,
          expectedHeadSha: action.expectedHeadSha,
        });
      }
      case "open_pr": {
        const repo = this.deps.repo(action.taskId);
        const existing = await this.deps.pullRequests.read(
          adapters,
          repo.github,
          action.branch,
        );
        if (existing) return { number: existing.number, url: existing.url };
        const opened = await adapters.github.openPullRequest({
          repo: repo.github,
          branch: action.branch,
          baseBranch: action.baseBranch,
          title: action.title,
          body: action.body,
        });
        this.deps.pullRequests.forget(repo.github, action.branch);
        return opened;
      }
      case "merge_pr": {
        const repo = this.deps.repo(action.taskId);
        const result = await adapters.github.mergePullRequest({
          repo: repo.github,
          number: action.prNumber,
          matchHeadSha: action.matchHeadSha,
          auto: action.auto,
        });
        if (state.task.branch)
          this.deps.pullRequests.forget(repo.github, state.task.branch);
        return result;
      }
      case "disable_auto_merge": {
        const repo = this.deps.repo(action.taskId);
        await adapters.github.disableAutoMerge({
          repo: repo.github,
          number: action.prNumber,
        });
        if (state.task.branch)
          this.deps.pullRequests.forget(repo.github, state.task.branch);
        return {};
      }
      case "map_findings":
        return this.map(action, state);
      case "refresh": {
        if (action.owner === "github" && state.task.branch)
          this.deps.pullRequests.forget(
            this.deps.repo(action.taskId).github,
            state.task.branch,
          );
        if (action.owner === "codex_rate_limits")
          await (await adapters.codex(action.taskId)).readRateLimits();
        return {};
      }
      case "schedule":
        this.deps.schedule(action.taskId, action.at, action.why);
        return {};
      case "notify":
        this.deps.notify(action.level, action.title, action.body);
        return {};
      default: {
        // Handle unknown action kinds that may exist in the database but not in this executor version
        const unknownAction = action as unknown as {
          kind: string;
          key: string;
        };
        throw new Fatal(
          `Unknown action kind '${unknownAction.kind}' (key: ${unknownAction.key}). ` +
            `This may indicate a schema drift between core and store. ` +
            `Ensure the action kind is added to both packages/core/src/actions.ts ActionOutputs ` +
            `and packages/store/src/action-schemas.ts.`,
        );
      }
    }
  }

  private run(state: TaskState, runId: string) {
    const run = state.runs.find((r) => r.id === runId);
    if (!run) throw new Fatal(`Unknown run ${runId}`);
    return run;
  }

  /** The send gate, then the transport. Delivery is never inferred from what the transport says. */
  private async send(
    action: Extract<Action, { kind: "send_message" }>,
    state: TaskState,
  ): Promise<ActionOutputs["send_message"]> {
    const { adapters } = this.deps;
    const run = this.run(state, action.runId);
    const decision = await checkSendGate(
      adapters,
      this.deps.now(),
      run,
      action,
    );
    if (!decision.ok)
      throw new PreconditionFailed(`Refusing to send: ${decision.reason}`);
    const sessionId = run.sessionId;
    if (!sessionId) throw new PreconditionFailed("The run has no session");
    const startedAt = this.deps.now() as IsoTime;
    const transport = async (): Promise<{ transportRef: string | null }> => {
      switch (action.via) {
        case "codex_turn_start": {
          const codex = await adapters.codex(action.taskId);
          return {
            transportRef: (
              await codex.startTurn({
                threadId: sessionId,
                text: action.text,
                model: run.model,
                ...(run.reasoningEffort ? { effort: run.reasoningEffort } : {}),
              })
            ).turnId,
          };
        }
        case "codex_turn_steer": {
          const codex = await adapters.codex(action.taskId);
          if (!action.expectedTurnId)
            throw new PreconditionFailed("A steer needs an expected turn");
          return {
            transportRef: (
              await codex.steerTurn({
                threadId: sessionId,
                expectedTurnId: action.expectedTurnId,
                text: action.text,
              })
            ).turnId,
          };
        }
        case "claude_sdk":
          await adapters.claude.sendHeadless({ sessionId, text: action.text });
          return { transportRef: null };
        case "pane_paste": {
          if (!run.pane)
            throw new PreconditionFailed("The run has no pane to write into");
          // The host refuses a leading `/` or `!` itself; core never generates one either.
          await adapters.paneHost.pasteText(run.pane, action.text);
          return { transportRef: null };
        }
      }
    };
    const output = await transport();
    return {
      ...output,
      transportAttempt: {
        startedAt,
        completedAt: this.deps.now() as IsoTime,
        sessionId,
        sessionEpoch: run.sessionEpoch,
        runAttempt: run.attempts,
      },
    };
  }

  private async interrupt(
    action: Extract<Action, { kind: "interrupt_run" }>,
    state: TaskState,
  ): Promise<Record<string, never>> {
    const { adapters } = this.deps;
    const run = this.run(state, action.runId);
    if (!run.sessionId) return {};
    if (run.provider === "codex") {
      const turn = run.lastTurn;
      if (!turn) return {};
      const codex = await adapters.codex(action.taskId);
      await codex.interruptTurn({ threadId: run.sessionId, turnId: turn.id });
      return {};
    }
    if (run.mode === "headless")
      await adapters.claude.interruptHeadless(run.sessionId);
    else if (run.pane) await adapters.paneHost.sendKey(run.pane, "Escape");
    return {};
  }

  private async answerPanePrompt(
    action: Extract<Action, { kind: "answer_pane_prompt" }>,
    state: TaskState,
  ): Promise<Record<string, never>> {
    const { adapters } = this.deps;
    const run = this.run(state, action.runId);
    const decision = await checkPanePromptGate(adapters, this.deps.now(), run);
    if (!decision.ok)
      throw new PreconditionFailed(`Refusing to answer: ${decision.reason}`);
    if (!run.pane) throw new PreconditionFailed("The run has no pane");

    if (action.expectedDialog) {
      const observation = await observeRun(adapters, this.deps.now(), run);
      const p = observation.provider.ok ? observation.provider.value : null;
      const d = p?.provider === "claude" ? p.hooks.pendingDialog : null;
      const expected = action.expectedDialog;
      if (
        run.sessionEpoch !== expected.sessionEpoch ||
        p?.provider !== "claude" ||
        p.agentsEntry?.status !== "waiting" ||
        d?.kind !== "permission" ||
        d.requestId !== expected.requestId ||
        d.at !== expected.at ||
        d.command !== expected.command
      )
        throw new PreconditionFailed(
          "Operator permission occurrence is no longer current",
        );
    }
    // Handle different choice types
    if (typeof action.choice === "number") {
      // Numeric choice: paste digit, wait 300ms, then press Enter
      const digit = String(action.choice);
      await adapters.paneHost.pasteText(run.pane, digit);
      // Wait 300ms before sending Enter
      await new Promise((resolve) => setTimeout(resolve, 300));
      await adapters.paneHost.sendKey(run.pane, "Enter");
    } else if (action.choice === "enter") {
      // Just press Enter
      await adapters.paneHost.sendKey(run.pane, "Enter");
    } else if (action.choice === "escape") {
      // Press Escape
      await adapters.paneHost.sendKey(run.pane, "Escape");
    }

    return {};
  }

  /** Reads the hunks between each anchor's head and the new one, then maps the ranges. */
  private async map(
    action: Extract<Action, { kind: "map_findings" }>,
    state: TaskState,
  ): Promise<{ locations: ReturnType<typeof mapFindings> }> {
    const wanted = new Set<string>(action.findingIds);
    const byHead = new Map<Sha, Finding[]>();
    for (const finding of state.findings) {
      if (!wanted.has(finding.id) || !finding.anchor) continue;
      const from = finding.location?.headSha ?? finding.anchor.headSha;
      byHead.set(from, [...(byHead.get(from) ?? []), finding]);
    }
    const locations: ReturnType<typeof mapFindings> = [];
    for (const [fromSha, findings] of byHead) {
      if (fromSha === action.toHeadSha) continue;
      const changes = await this.deps.adapters.git.changedFiles({
        repoRoot: action.worktreePath,
        fromSha,
        toSha: action.toHeadSha,
      });
      locations.push(
        ...mapFindings({
          findings,
          findingIds: findings.map((f) => f.id),
          toHeadSha: action.toHeadSha,
          changes: indexChanges(changes),
          mappedAt: this.deps.now(),
        }),
      );
    }
    return { locations };
  }
}
