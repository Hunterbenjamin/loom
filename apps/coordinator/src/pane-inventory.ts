import {
  deriveAttention,
  displayName,
  type GitAdapter,
  issueKey,
  type PaneHost,
  type PaneObservation,
  type TaskState,
} from "@loom/core";
import { type PaneView, paneView } from "@loom/protocol";

export const paneKey = (p: { hostGeneration: string; paneId: string }) =>
  JSON.stringify([p.hostGeneration, p.paneId]);

/** Only recorded physical references join runs. Cwd, titles and native tags are not identity. */
export function assemblePanes(
  observations: PaneObservation[],
  states: TaskState[],
  counts: Map<string, number>,
  now: string,
  leadPane: string | null,
  leadWaiting: boolean,
  leadPanes: ReadonlySet<string> = new Set(),
  repos: import("@loom/core").Repo[] = [],
): PaneView[] {
  return observations.map((p) => {
    const matches = states.flatMap((state) =>
      state.runs
        .filter((r) => r.pane && paneKey(r.pane) === paneKey(p.ref))
        .map((run) => ({ state, run })),
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    const workspaces = states.filter(
      (s) =>
        s.worktree?.paneWorkspaceId === (p.workspaceId ?? p.ref.sessionName),
    );
    const task =
      match?.state.task ??
      (workspaces.length === 1 ? workspaces[0]?.task : undefined);
    const repo = task
      ? repos.find((repo) => repo.id === task.repoId)
      : undefined;
    let attention =
      (leadPane === paneKey(p.ref) && leadWaiting) ||
      leadPanes.has(paneKey(p.ref));
    if (match) {
      const s = match.state;
      const derived = deriveAttention({
        now: now as never,
        previous: s.task.attention,
        stage: s.task.stage,
        blocked: s.task.blocked,
        failed: s.task.failed,
        budgetMinutes: s.task.budgetMinutes,
        activeElapsedMs: s.activeElapsedMs,
        runs: s.runs,
        questions: s.questions,
        messages: s.messages,
        stallAfterMs: s.config.stallAfterMs,
        fixRoundStallAfterMs: s.config.fixRoundStallAfterMs,
        unknownGraceMs: s.config.unknownGraceMs,
      });
      attention = Object.values(derived.reasonRunIds).some((ids) =>
        ids.includes(match.run.id),
      );
    }
    return paneView.parse({
      ...p.ref,
      id: paneKey(p.ref),
      sessionId: p.sessionId ?? null,
      windowName: p.windowName ?? null,
      windowIndex: p.windowIndex,
      windowLayout: p.windowLayout,
      title: p.title ?? null,
      command: p.command,
      agent: p.agent ?? null,
      startCwd: p.startCwd,
      dead: p.dead,
      exitStatus: p.exitCode,
      attachedClients: counts.get(p.ref.sessionName) ?? 0,
      unavailable: false,
      taskId: task?.id ?? null,
      taskName: task ? displayName(task) : null,
      issueKey: task && repo ? issueKey(repo, task) : null,
      taskStage: task?.stage ?? null,
      branch: task?.branch ?? null,
      runId: match?.run.id ?? null,
      role: match?.run.role ?? null,
      provider: match?.run.provider ?? null,
      status: match?.run.status ?? null,
      attention,
    });
  });
}

/** One scan at a time; hints during a scan request one further pass. Failures retain evidence. */
export class PaneInventory {
  rows: PaneView[] = [];
  unavailable = false;
  private pending: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  constructor(
    private host: PaneHost,
    private git: Pick<GitAdapter, "currentBranch">,
    private metadata: () => {
      states: TaskState[];
      repos?: import("@loom/core").Repo[];
      now: string;
      leadPane?: string | null;
      leadWaiting?: boolean;
      leadPanes?: ReadonlySet<string>;
    },
    private publish: (rows: PaneView[], unavailable: boolean) => void,
  ) {}
  private readonly reaped = new Set<string>();
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = this.drain().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async drain() {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      try {
        const panes = await this.host.listPanes();
        const representatives = new Map(
          panes.map((p) => [p.ref.sessionName, p.ref]),
        );
        const counts = new Map(
          await Promise.all(
            [...representatives].map(
              async ([s, ref]) =>
                [s, (await this.host.listClients(ref)).length] as const,
            ),
          ),
        );
        const m = this.metadata();
        const rows = assemblePanes(
          panes,
          m.states,
          counts,
          m.now,
          m.leadPane ?? null,
          m.leadWaiting ?? false,
          m.leadPanes,
          m.repos ?? [],
        );
        // Share each cwd read (including failures) for this refresh only. The next
        // poll or hint must observe branch switches and recover unreadable paths.
        const branches = new Map<string, Promise<string | null>>();
        this.rows = await Promise.all(
          rows.map(async (row) => {
            if (row.taskId !== null) return row;
            let branch = branches.get(row.startCwd);
            if (!branch) {
              branch = this.git
                .currentBranch(row.startCwd)
                .then((value) => value ?? "HEAD")
                .catch(() => null);
              branches.set(row.startCwd, branch);
            }
            return paneView.parse({ ...row, branch: await branch });
          }),
        );
        // Closing is killing all the way up: tmux keeps an exited process's pane (remain-on-exit)
        // so a Loom run's death can be observed first. A dead pane nobody owns is reaped at once,
        // and tmux then drops an emptied window and session on its own.
        // The host's hint after the kill triggers the scan that drops the row; each pane is
        // asked once, so a host that keeps reporting it never causes a kill loop. A pane the
        // host tagged with a run id at launch is Loom's even before the run record links it:
        // its death is an observation for the supervisor, never something to tidy away.
        const owned = new Set(
          panes.filter((p) => p.owner).map((p) => paneKey(p.ref)),
        );
        for (const row of this.rows) {
          // A dead pane of a run that has ended has nothing left to observe either.
          if (
            !row.dead ||
            owned.has(row.id) ||
            (row.runId && row.status !== "ended") ||
            row.unavailable ||
            row.sessionName.startsWith("loom-lead") ||
            ["loom-main", "loom-operator"].includes(row.sessionName) ||
            this.reaped.has(row.id)
          )
            continue;
          this.reaped.add(row.id);
          await this.host
            .closeTerminal({
              hostGeneration: row.hostGeneration,
              sessionName: row.sessionName,
              windowId: row.windowId,
              paneId: row.paneId,
            })
            .catch(() => {});
        }
        this.unavailable = false;
      } catch {
        this.unavailable = true;
        this.rows = this.rows.map((p) =>
          p.unavailable ? p : { ...p, unavailable: true },
        );
      }
      if (!this.stopped) this.publish(this.rows, this.unavailable);
    }
  }
  async stop() {
    this.stopped = true;
    await this.pending;
  }
}
