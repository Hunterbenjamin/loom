import type { Task } from "@loom/core";
import { shallowArray, useStore } from "../store/react.js";
import { taskRuns } from "../store/selectors.js";
import { stageLabel } from "./format.js";

export function useTaskEvents(task: Task) {
  const notes = useStore(
    (s) => s.notes.filter((n) => n.taskId === task.id),
    shallowArray,
  );
  const transitions = useStore(
    (s) => s.snapshot.transitions.filter((t) => t.taskId === task.id),
    shallowArray,
  );
  const runs = useStore((s) => taskRuns(s.snapshot, task), shallowArray);
  const messages = useStore(
    (s) =>
      s.snapshot.messages.filter((m) =>
        s.snapshot.runs.some((r) => r.id === m.runId && r.taskId === task.id),
      ),
    shallowArray,
  );
  const now = useStore((s) => s.snapshot.now);

  const events = [
    ...notes.map((n) => ({
      id: n.id,
      at: n.at as import("@loom/core").IsoTime,
      kind: "note",
      text: n.body,
      detail: `${n.author} · ${n.row} · ${n.outcome}`,
    })),
    ...transitions.map((transition) => ({
      id: transition.id as string,
      at: transition.at,
      kind: transition.from === transition.to ? "flag" : "stage",
      text:
        transition.from === transition.to
          ? transition.reason
          : `${stageLabel(transition.from)} → ${stageLabel(transition.to)}`,
      detail:
        transition.trigger.kind === "human"
          ? `human · ${transition.trigger.command}`
          : transition.trigger.kind === "mcp"
            ? `mcp · ${transition.trigger.tool}`
            : `reconcile · ${transition.trigger.fact}`,
    })),
    ...messages.map((message) => ({
      id: message.id as string,
      at: message.sentAt ?? now,
      kind: "message",
      text: message.text,
      detail: `${message.purpose} · ${message.status}`,
    })),
    ...runs.flatMap((run) =>
      run.launchedAt
        ? [
            {
              id: `${run.id}:launched`,
              at: run.launchedAt,
              kind: "run",
              text: `${run.role} run launched on ${run.provider}`,
              detail: `${run.model} · attempt ${run.attempts}`,
            },
          ]
        : [],
    ),
    ...runs.flatMap((run) =>
      run.endedAt
        ? [
            {
              id: `${run.id}:ended`,
              at: run.endedAt,
              kind: "run",
              text: `${run.role} run ended`,
              detail: run.endReason ?? "",
            },
          ]
        : [],
    ),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return events;
}
