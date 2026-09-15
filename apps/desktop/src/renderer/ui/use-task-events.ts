import type { MessagePurpose, Run, Task } from "@loom/core";
import { shallowArray, useStore } from "../store/react.js";
import { taskRuns } from "../store/selectors.js";
import type { ActivityItem } from "./activity.js";
import { stageLabel } from "./format.js";

const role = (run: Run | undefined) =>
  run ? `${run.role[0]?.toUpperCase()}${run.role.slice(1)}` : "Agent";

/** What each kind of message to an agent was for; only human-written text is shown in full. */
const MESSAGE_LABELS: Record<MessagePurpose, (agent: string) => string> = {
  initial: (agent) => `${agent} received its brief`,
  fix_round: (agent) => `${agent} received a fix round`,
  answer: (agent) => `Answered the ${agent.toLowerCase()}'s question`,
  plan_feedback: () => "Sent plan feedback",
  restart_continuation: (agent) => `${agent} was asked to continue`,
  human: (agent) => `You messaged the ${agent.toLowerCase()}`,
};
const HUMAN_WRITTEN: MessagePurpose[] = ["answer", "plan_feedback", "human"];

/** The issue's own activity, in the same shape as a pull request's. */
export function useTaskEvents(task: Task): ActivityItem[] {
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

  const item = (
    value: Omit<ActivityItem, "url" | "body"> &
      Partial<Pick<ActivityItem, "body">>,
  ): ActivityItem => ({ url: null, body: "", ...value });
  return [
    ...notes.map((note) =>
      item({
        id: note.id,
        at: note.at,
        kind: "note",
        label: `${note.author === "human" ? "You" : "Main"} noted`,
        body: note.body,
      }),
    ),
    ...transitions.map((transition) =>
      transition.from === transition.to
        ? item({
            id: transition.id,
            at: transition.at,
            kind: "flag",
            label: transition.reason,
          })
        : item({
            id: transition.id,
            at: transition.at,
            kind: "stage",
            label: `${stageLabel(transition.from)} → ${stageLabel(transition.to)}${transition.trigger.kind === "human" ? " by you" : ""}`,
          }),
    ),
    ...messages.flatMap((message) => {
      if (!message.sentAt && message.status !== "failed") return [];
      const agent = role(runs.find((run) => run.id === message.runId));
      return [
        item({
          id: message.id,
          at: message.sentAt,
          kind: "message",
          label: `${MESSAGE_LABELS[message.purpose](agent)}${message.status === "failed" ? " · not delivered" : ""}`,
          body: HUMAN_WRITTEN.includes(message.purpose) ? message.text : "",
        }),
      ];
    }),
    ...runs.flatMap((run) => [
      ...(run.launchedAt
        ? [
            item({
              id: `${run.id}:launched`,
              at: run.launchedAt,
              kind: "run",
              label: `${role(run)} started on ${run.provider} · ${run.model}`,
            }),
          ]
        : []),
      ...(run.endedAt
        ? [
            item({
              id: `${run.id}:ended`,
              at: run.endedAt,
              kind: "run",
              label: `${role(run)} finished${run.endReason ? ` · ${run.endReason.replaceAll("_", " ")}` : ""}`,
            }),
          ]
        : []),
    ]),
  ];
}
