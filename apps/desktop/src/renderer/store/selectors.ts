import type { Finding, Run, Stage, Task } from "@loom/core";
import { type Snapshot, STAGES } from "../fixtures/index.js";
import {
  matchesView,
  type SortKey,
  type State,
  VIEWS,
  type ViewId,
} from "./store.js";

/** One row of the list: the task plus the few facts the columns need, computed once. */
export interface Row {
  task: Task;
  /** The run the human would look at first: the live one, else the last one. */
  run: Run | null;
  runs: Run[];
  openBlocking: number;
  ageMinutes: number;
  stageMinutes: number;
}

const stageOrder = new Map(STAGES.map((stage, index) => [stage, index]));

function memo1<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  let last: { args: A; value: R } | null = null;
  return (...args: A) => {
    if (
      last &&
      last.args.length === args.length &&
      last.args.every((a, i) => a === args[i])
    ) {
      return last.value;
    }
    const value = fn(...args);
    last = { args, value };
    return value;
  };
}

const liveStatuses: Run["status"][] = [
  "starting",
  "working",
  "blocked",
  "idle",
  "unknown",
];

const isLive = (run: Run): boolean => liveStatuses.includes(run.status);

/**
 * The run that started last. Loom records `launchedAt` for the runs it starts; an adopted
 * external session has none, so it counts as older than any launched run. Among equals the later
 * row wins, so the order runs arrived in breaks the tie the same way every time.
 */
function newest(runs: readonly Run[]): Run | null {
  let best: Run | null = null;
  for (const run of runs)
    if (!best || (run.launchedAt ?? "") >= (best.launchedAt ?? "")) best = run;
  return best;
}

const computeRows = memo1(
  (snapshot: Snapshot, view: ViewId, repo: string, query: string): Row[] => {
    const byTask = new Map<string, Run[]>();
    for (const run of snapshot.runs) {
      const list = byTask.get(run.taskId);
      if (list) list.push(run);
      else byTask.set(run.taskId, [run]);
    }
    const blocking = new Map<string, number>();
    for (const finding of snapshot.findings) {
      if (
        !finding.blocking ||
        finding.status === "resolved" ||
        finding.status === "waived"
      )
        continue;
      blocking.set(finding.taskId, (blocking.get(finding.taskId) ?? 0) + 1);
    }
    const needle = query.trim().toLowerCase();
    const now = Date.parse(snapshot.now);
    const rows: Row[] = [];
    for (const task of snapshot.tasks) {
      if (repo !== "all" && task.repoId !== repo) continue;
      if (!matchesView(task, view)) continue;
      if (needle && !`${task.id} ${task.title}`.toLowerCase().includes(needle))
        continue;
      const runs = byTask.get(task.id) ?? [];
      rows.push({
        task,
        runs,
        run: newest(runs.filter(isLive)) ?? newest(runs),
        openBlocking: blocking.get(task.id) ?? 0,
        ageMinutes: Math.round((now - Date.parse(task.createdAt)) / 60_000),
        stageMinutes: Math.round(
          (now - Date.parse(task.stageEnteredAt)) / 60_000,
        ),
      });
    }
    return rows;
  },
);

let previousRows:
  | {
      snapshot: Snapshot;
      view: ViewId;
      repo: string;
      query: string;
      rows: Row[];
    }
  | undefined;
export function rowsFor(
  snapshot: Snapshot,
  view: ViewId,
  repo: string,
  query: string,
): Row[] {
  const p = previousRows;
  if (
    p &&
    p.snapshot.tasks === snapshot.tasks &&
    p.snapshot.runs === snapshot.runs &&
    p.snapshot.findings === snapshot.findings &&
    p.view === view &&
    p.repo === repo &&
    p.query === query
  )
    return p.rows;
  const rows = computeRows(snapshot, view, repo, query);
  previousRows = { snapshot, view, repo, query, rows };
  return rows;
}

export const sortRows = memo1(
  (rows: Row[], sort: SortKey, descending: boolean): Row[] => {
    const direction = descending ? -1 : 1;
    const sorted = [...rows].sort((a, b) => {
      switch (sort) {
        case "stage": {
          const delta =
            (stageOrder.get(a.task.stage) ?? 0) -
              (stageOrder.get(b.task.stage) ?? 0) ||
            a.stageMinutes - b.stageMinutes;
          return delta * direction;
        }
        case "title":
          return a.task.title.localeCompare(b.task.title) * direction;
        case "attention":
          return (
            (b.task.attention.reasons.length -
              a.task.attention.reasons.length ||
              a.task.title.localeCompare(b.task.title)) * direction
          );
        case "provider":
          return (
            ((a.run?.provider ?? "").localeCompare(b.run?.provider ?? "") ||
              a.task.title.localeCompare(b.task.title)) * direction
          );
        case "round":
          return (
            (b.task.reviewRound - a.task.reviewRound ||
              a.ageMinutes - b.ageMinutes) * direction
          );
        case "age":
          return (b.ageMinutes - a.ageMinutes) * direction;
        default:
          return 0;
      }
    });
    return sorted;
  },
);

export interface Group {
  stage: Stage;
  rows: Row[];
}

/** List rows are grouped by stage and then flattened, so one virtualizer covers headers too. */
export type ListItem =
  | { kind: "header"; stage: Stage; count: number }
  | { kind: "row"; row: Row };

export const groupRows = memo1((rows: Row[]): ListItem[] => {
  const byStage = new Map<Stage, Row[]>();
  for (const row of rows) {
    const list = byStage.get(row.task.stage);
    if (list) list.push(row);
    else byStage.set(row.task.stage, [row]);
  }
  const items: ListItem[] = [];
  for (const stage of STAGES) {
    const group = byStage.get(stage);
    if (!group || group.length === 0) continue;
    items.push({ kind: "header", stage, count: group.length });
    for (const row of group) items.push({ kind: "row", row });
  }
  return items;
});

export const viewCounts = memo1(
  (snapshot: Snapshot, repo: string): Record<ViewId, number> => {
    const counts = {
      all: 0,
      "needs-you": 0,
      "in-progress": 0,
      "awaiting-approval": 0,
      done: 0,
    };
    for (const task of snapshot.tasks) {
      if (repo !== "all" && task.repoId !== repo) continue;
      for (const view of VIEWS)
        if (matchesView(task, view.id)) counts[view.id] += 1;
    }
    return counts;
  },
);

export function selectedRows(state: State): Row[] {
  const rows = rowsFor(
    state.snapshot,
    state.ui.view,
    state.ui.repo,
    state.ui.query,
  );
  return sortRows(rows, state.ui.sort, state.ui.descending);
}

export function taskRuns(snapshot: Snapshot, task: Task): Run[] {
  return snapshot.runs.filter((run) => run.taskId === task.id);
}

export function taskFindings(snapshot: Snapshot, task: Task): Finding[] {
  return snapshot.findings.filter((finding) => finding.taskId === task.id);
}
