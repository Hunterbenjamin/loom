// Fresh reads from every owner, outside any transaction (design §5.1 step 3). Nothing here
// decides anything: a failed read is `ok: false`, which core treats as unknown, never as proof.

import type {
  CapacityObservation,
  ClaudeSessionObservation,
  CodexThreadObservation,
  ExternalSessionObservation,
  Input,
  Observations,
  Provider,
  PullRequestObservation,
  Reading,
  Run,
  RunObservation,
  Sha,
  TaskState,
  WorktreePath,
} from "@loom/core";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";

const reading = async <T>(
  now: string,
  read: () => Promise<T>,
): Promise<Reading<T>> => {
  try {
    return { ok: true, value: await read(), at: now as never };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      at: now as never,
    };
  }
};

/** Conditional GitHub reads: the ETag and the last body belong to the coordinator, not to core. */
export class PullRequestCache {
  private entries = new Map<
    string,
    { etag: string | null; value: PullRequestObservation | null }
  >();
  async read(
    adapters: Adapters,
    repo: string,
    branch: string,
  ): Promise<PullRequestObservation | null> {
    const key = `${repo} ${branch}`;
    const cached = this.entries.get(key);
    const result = await adapters.github.findPullRequest({
      repo,
      branch,
      etag: cached?.etag ?? null,
    });
    if (result.notModified) {
      if (!cached)
        throw new Error("GitHub answered not-modified without a cached body");
      return cached.value;
    }
    this.entries.set(key, { etag: result.etag, value: result.value });
    return result.value;
  }
  forget(repo: string, branch: string): void {
    this.entries.delete(`${repo} ${branch}`);
  }
}

/** Provider status for one live run, plus the pane the host reports for an interactive one. */
export async function observeRun(
  adapters: Adapters,
  now: string,
  run: Run,
): Promise<RunObservation> {
  const provider: Reading<
    CodexThreadObservation | ClaudeSessionObservation | null
  > =
    run.sessionId === null
      ? { ok: true, value: null, at: now as never }
      : run.provider === "codex"
        ? await reading(now, async () => {
            const codex = await adapters.codex(run.taskId);
            return (await codex.readThread(
              run.sessionId as never,
            )) as CodexThreadObservation;
          })
        : await reading(now, async () => {
            const sessionId = run.sessionId as never;
            const [sessions, hooks, headless] = await Promise.all([
              adapters.claude.listSessions(),
              adapters.claude.hookSummary(sessionId),
              adapters.claude.headlessState(sessionId),
            ]);
            return {
              provider: "claude" as const,
              sessionId,
              agentsEntry:
                sessions.find((s) => s.sessionId === sessionId) ?? null,
              hooks,
              headless,
            };
          });
  const pane =
    run.mode === "interactive" && run.pane
      ? await reading(now, () => adapters.paneHost.getPane(run.pane as never))
      : null;
  // `resumable: null` is uncertainty, and must trigger a further owner read when recovery needs
  // it (design §5.2). Ask the provider directly rather than inferring from the failed read.
  let resumable: boolean | null = null;
  if (run.sessionId)
    try {
      resumable =
        run.provider === "codex"
          ? await (await adapters.codex(run.taskId)).checkResumable(
              run.sessionId,
            )
          : await adapters.claude.resumable(run.sessionId, run.worktreePath);
    } catch {
      resumable = null;
    }
  let activityAt: RunObservation["activityAt"] = null;
  if (run.sessionId)
    try {
      activityAt =
        run.provider === "codex"
          ? (await adapters.codex(run.taskId)).activityAt(run.sessionId)
          : await adapters.claude.activityAt(run.sessionId);
    } catch {
      activityAt = null;
    }
  return { runId: run.id, provider, pane, resumable, activityAt };
}

/**
 * Sessions in this task's worktree that Loom didn't launch, joined on realpath (principle 6).
 * `claude agents --json` is the only list a provider offers; a Codex thread Loom doesn't own is
 * not discoverable through the app-server, so it stays invisible until it is.
 */
export async function observeExternal(
  adapters: Adapters,
  state: TaskState,
  /** Every session Loom has ever launched, from the launch recipes. A run that has scrolled out
   * of the loaded snapshot is still Loom's, and must never be adopted as an external session. */
  launched: ReadonlySet<string> = new Set(),
): Promise<ExternalSessionObservation[]> {
  const worktree = state.task.worktreePath;
  if (!worktree) return [];
  let canonical: WorktreePath;
  try {
    canonical = await adapters.git.realpath(worktree);
  } catch {
    return [];
  }
  const sessions = await adapters.claude.listSessions().catch(() => []);
  const known = new Set([
    ...state.runs.map((r) => `${r.provider} ${r.sessionId}`),
    ...[...launched].map((id) => `claude ${id}`),
  ]);
  const external: ExternalSessionObservation[] = [];
  for (const entry of sessions) {
    if (known.has(`claude ${entry.sessionId}`)) continue;
    let cwd: WorktreePath;
    try {
      cwd = await adapters.git.realpath(entry.cwd);
    } catch {
      continue;
    }
    if (cwd !== canonical) continue;
    external.push({
      provider: "claude",
      sessionId: entry.sessionId,
      cwd,
      kind: entry.kind,
      active: entry.status === "busy" || entry.status === "waiting",
    });
  }
  return external;
}

export interface CapacityReader {
  counts(): { version: number; active: Record<Provider, number> };
}

export interface ObserveDeps {
  adapters: Adapters;
  config: CoordinatorConfig;
  pullRequests: PullRequestCache;
  capacity: CapacityReader;
  dependencies(): Observations["dependencies"];
  inputs(): Input[];
  coolingDownUntil(): Record<Provider, string | null>;
  /** Session IDs Loom launched, so its own runs are never mistaken for hand-started ones. */
  launchedSessions(): ReadonlySet<string>;
  repoOf(state: TaskState): { github: string; baseBranch: string } | null;
  now(): string;
}

/** One pass's observations. Every failure stays a failed `Reading`; nothing is invented. */
export async function observe(
  deps: ObserveDeps,
  state: TaskState,
): Promise<Observations> {
  const now = deps.now();
  const repo = deps.repoOf(state);
  const worktree = state.task.worktreePath;
  const inputs = deps.inputs();
  // The git boundary must be able to answer every pending `resolve_finding` fixing commit.
  const candidates = new Set<Sha>();
  for (const input of inputs)
    if (
      input.type === "mcp" &&
      input.call.tool === "resolve_finding" &&
      input.call.input.commitSha
    )
      candidates.add(input.call.input.commitSha);
  for (const finding of state.findings)
    if (finding.resolution?.commitSha)
      candidates.add(finding.resolution.commitSha);
  const git = worktree
    ? await reading(now, () =>
        deps.adapters.git.readWorktree(
          worktree,
          repo?.baseBranch ?? deps.config.baseBranch,
          [...candidates],
        ),
      )
    : null;
  const github =
    repo && state.task.branch
      ? await reading(now, () =>
          deps.pullRequests.read(
            deps.adapters,
            repo.github,
            state.task.branch as string,
          ),
        )
      : null;
  // Live runs, plus each role's latest run even when it has ended: a human retry relaunches
  // that run, and core rotates its session only on `resumable: false` from a real read. Without
  // the observation every retry of a Codex run whose rollout was gone resumed the dead thread
  // and vanished again (2026-09-12, five attempts on the Workbench task).
  const latestByRole = new Map<string, (typeof state.runs)[number]>();
  for (const r of state.runs)
    if (r.origin === "loom") latestByRole.set(r.role, r);
  const live = state.runs.filter(
    (r) =>
      r.origin === "loom" &&
      (!r.endedAt || (latestByRole.get(r.role) === r && r.sessionId)),
  );
  const runs = await Promise.all(
    live.map((run) => observeRun(deps.adapters, now, run)),
  );
  const counts = deps.capacity.counts();
  const capacity: CapacityObservation = {
    version: counts.version,
    active: counts.active,
    caps: deps.config.caps,
    coolingDownUntil:
      deps.coolingDownUntil() as CapacityObservation["coolingDownUntil"],
  };
  return {
    now: now as never,
    git,
    github,
    runs,
    externalSessions: await observeExternal(
      deps.adapters,
      state,
      deps.launchedSessions(),
    ),
    capacity,
    dependencies: deps.dependencies(),
    inputs,
  };
}
