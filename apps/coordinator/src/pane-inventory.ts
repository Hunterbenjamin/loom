import {
  deriveAttention,
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
): PaneView[] {
  return observations.map((p) => {
    const matches = states.flatMap((state) =>
      state.runs
        .filter((r) => r.pane && paneKey(r.pane) === paneKey(p.ref))
        .map((run) => ({ state, run })),
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    const workspaces = states.filter(
      (s) => s.worktree?.paneWorkspaceId === p.ref.sessionName,
    );
    const task =
      match?.state.task ??
      (workspaces.length === 1 ? workspaces[0]?.task : undefined);
    let attention = leadPane === paneKey(p.ref) && leadWaiting;
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
      title: p.title ?? null,
      command: p.command,
      startCwd: p.startCwd,
      dead: p.dead,
      exitStatus: p.exitCode,
      attachedClients: counts.get(p.ref.sessionName) ?? 0,
      unavailable: false,
      taskId: task?.id ?? null,
      taskLabel: task ? `${task.id} · ${task.title}` : null,
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
    private metadata: () => {
      states: TaskState[];
      now: string;
      leadPane: string | null;
      leadWaiting: boolean;
    },
    private publish: (rows: PaneView[], unavailable: boolean) => void,
  ) {}
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
        this.rows = assemblePanes(
          panes,
          m.states,
          counts,
          m.now,
          m.leadPane,
          m.leadWaiting,
        );
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
