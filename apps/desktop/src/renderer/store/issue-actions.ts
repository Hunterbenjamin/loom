import type {
  AttentionReason,
  Finding,
  FindingStatus,
  HumanCommand,
  IsoTime,
  Run,
  Stage,
  Task,
  TaskId,
} from "@loom/core";
import { findingId } from "@loom/protocol";
import { inputId, minutesBefore, transitionId } from "../fixtures/ids.js";
import type { Comment } from "../fixtures/index.js";
import { REASON_LABELS } from "./inbox.js";
import { taskRuns, terminalsForTask } from "./selectors.js";
import type { State, StoreContext } from "./store.js";

export interface DecisionAction {
  id: string;
  label: string;
  disabledReason: string | null;
  command?: (text?: string) => HumanCommand;
  intent?: "terminal" | "pull-request" | "plan" | "review";
}

export interface IssueDecision {
  key: string;
  kind: AttentionReason | "provider_request" | "pane_prompt";
  label: string;
  since: IsoTime | null;
  runs: Run[];
  planVersion?: number | null;
  planGoal?: string | null;
  reviewedHead?: string | null;
  questions?: State["snapshot"]["questions"];
  reason?: string | null;
  request?: Run["pendingRequests"][number];
  dialog?: NonNullable<Run["pendingDialog"]>;
  actions: DecisionAction[];
}

interface IssueActionState {
  decisions: IssueDecision[];
  status: {
    summary: string;
    lastActivityAt: IsoTime | null;
    secondaryActions: DecisionAction[];
  };
}

const failures: AttentionReason[] = [
  "failed",
  "blocked",
  "run_vanished",
  "stalled",
  "idle_without_submission",
  "status_unknown",
  "observability_failure",
  "over_budget",
];

const unavailable = (state: State) =>
  !state.live
    ? "Actions are unavailable in fixture mode"
    : state.connection !== "connected"
      ? "Connect to the coordinator to use this action"
      : null;

const disabled = (state: State, reason: string | null) =>
  unavailable(state) ?? reason;

function reasonActions(
  state: State,
  task: Task,
  reason: AttentionReason,
  planVersion: number | null,
  reviewedHead: string | null,
  questions: State["snapshot"]["questions"],
): DecisionAction[] {
  if (reason === "plan_needs_approval")
    return [
      {
        id: "approve-plan",
        label: "Approve plan",
        disabledReason: disabled(
          state,
          task.stage !== "plan_approval"
            ? "Plan approval is only available in Plan approval"
            : planVersion == null
              ? "The latest plan version is unavailable"
              : null,
        ),
        command: () => ({
          type: "approve_plan",
          planVersion: planVersion ?? -1,
        }),
      },
      {
        id: "change-plan",
        label: "Change plan",
        disabledReason: disabled(
          state,
          task.stage !== "plan_approval"
            ? "Plan changes are only available in Plan approval"
            : planVersion == null
              ? "The latest plan version is unavailable"
              : null,
        ),
        command: (text = "") => ({ type: "reject_plan", feedback: text }),
      },
    ];
  if (reason === "needs_approval")
    return [
      {
        id: "approve-merge",
        label: "Approve merge",
        disabledReason: disabled(
          state,
          task.stage !== "awaiting_approval"
            ? "Merge approval is only available in Awaiting approval"
            : !reviewedHead
              ? "The reviewed head SHA is unavailable"
              : null,
        ),
        command: () => ({
          type: "approve",
          headSha: (reviewedHead ?? "") as never,
        }),
      },
      {
        id: "request-changes",
        label: "Request changes",
        disabledReason: disabled(
          state,
          !["awaiting_approval", "in_review"].includes(task.stage)
            ? "Changes can only be requested during review"
            : null,
        ),
        command: (text = "") => ({
          type: "request_changes",
          findings: [
            {
              id: findingId.parse(`${task.id}/human/${crypto.randomUUID()}`),
              severity: "major",
              title: "Requested changes",
              body: text,
              anchor: null,
            },
          ],
        }),
      },
    ];
  if (reason === "question")
    return [
      {
        id: "answer-question",
        label: "Answer question",
        disabledReason: disabled(
          state,
          questions.length
            ? "Enter an answer"
            : "No open question is available",
        ),
        command: (text = "") => ({
          type: "answer_question",
          questionId: questions[0]?.id ?? ("" as never),
          answer: text,
        }),
      },
    ];
  if (failures.includes(reason))
    return [
      {
        id: "retry",
        label: "Retry",
        disabledReason: disabled(
          state,
          task.blocked ? "Resolve the blocked reason before retrying" : null,
        ),
        command: () => ({ type: "retry" }),
      },
      {
        id: "open-terminal",
        label: "Open terminal",
        disabledReason: terminalsForTask(state.snapshot, task).length
          ? null
          : "No live terminal is available",
        intent: "terminal",
      },
    ];
  return [];
}

let cache:
  | {
      tasks: Task[];
      runs: Run[];
      inbox: State["inbox"];
      questions: State["snapshot"]["questions"];
      plans: State["snapshot"]["plans"];
      connection: string;
      task: Task;
      result: IssueActionState;
    }
  | undefined;

/** Derives every available issue decision from coordinator-owned task state, never navigation. */
export function issueDecisions(state: State, task: Task): IssueActionState {
  const { tasks, runs, questions, plans } = state.snapshot;
  if (
    cache?.tasks === tasks &&
    cache.runs === runs &&
    cache.inbox === state.inbox &&
    cache.questions === questions &&
    cache.plans === plans &&
    cache.connection === state.connection &&
    cache.task === task
  )
    return cache.result;
  const info = state.inbox.find((item) => item.taskId === task.id);
  const allRuns = taskRuns(state.snapshot, task);
  const openQuestions = questions.filter(
    (question) => question.taskId === task.id && question.answer === null,
  );
  const decisions: IssueDecision[] = task.attention.reasons.map((reason) => {
    const reasonRuns = info?.reasonRuns[reason] ?? allRuns;
    const planVersion = info?.planVersion ?? plans[task.id]?.version ?? null;
    const planGoal =
      plans[task.id]?.version === planVersion ? plans[task.id]?.goal : null;
    const reviewedHead = info?.reviewedHead ?? null;
    return {
      key: `reason:${reason}`,
      kind: reason,
      label: REASON_LABELS[reason],
      since: task.attention.reasonSince[reason] ?? task.attention.since,
      runs: reasonRuns,
      planVersion,
      planGoal,
      reviewedHead,
      questions: reason === "question" ? openQuestions : undefined,
      reason:
        reason === "blocked"
          ? (task.blocked?.detail ?? task.blocked?.reason ?? null)
          : reason === "failed"
            ? (task.failed?.detail ?? task.failed?.reason ?? null)
            : null,
      actions: reasonActions(
        state,
        task,
        reason,
        planVersion,
        reviewedHead,
        openQuestions,
      ),
    };
  });
  for (const run of allRuns) {
    for (const request of run.pendingRequests)
      decisions.push({
        key: `request:${run.id}:${request.generation ?? "-"}:${request.id}`,
        kind: "provider_request",
        label: "Provider request",
        since: request.receivedAt,
        runs: [run],
        request,
        actions: [
          ...(["accept", "decline"] as const).map((decision) => ({
            id: `${decision}-request`,
            label: decision === "accept" ? "Accept" : "Decline",
            disabledReason: disabled(state, null),
            command: (): HumanCommand => ({
              type: "answer_provider_request",
              runId: run.id,
              requestId: request.id,
              generation: request.generation,
              decision,
              answers: null,
            }),
          })),
        ],
      });
    if (run.pendingDialog)
      decisions.push({
        key: `dialog:${run.id}:${run.pendingDialog.at}`,
        kind: "pane_prompt",
        label: "Terminal prompt",
        since: run.pendingDialog.at,
        runs: [run],
        dialog: run.pendingDialog,
        actions: [
          {
            id: "open-terminal",
            label: "Open terminal",
            disabledReason: null,
            intent: "terminal",
          },
          ...(["enter", "escape"] as const).map((choice) => ({
            id: `${choice}-prompt`,
            label: choice === "enter" ? "Press Enter" : "Press Escape",
            disabledReason: disabled(
              state,
              !run.pendingDialog?.requestId || !run.pendingDialog.command
                ? "The prompt identity is incomplete"
                : null,
            ),
            command: (): HumanCommand => ({
              type: "answer_pane_prompt",
              runId: run.id,
              choice,
              expectedDialog: {
                requestId: run.pendingDialog?.requestId ?? "",
                at: run.pendingDialog?.at ?? state.snapshot.now,
                command: run.pendingDialog?.command ?? "",
                sessionEpoch: run.sessionEpoch,
              },
            }),
          })),
        ],
      });
  }
  const current =
    [...allRuns].reverse().find((run) => !run.endedAt) ?? allRuns.at(-1);
  const terminal = terminalsForTask(state.snapshot, task)[0];
  const result: IssueActionState = {
    decisions,
    status: {
      summary: current
        ? `${current.role} on ${current.provider} is ${current.status}`
        : `Issue is ${task.stage.replaceAll("_", " ")}`,
      lastActivityAt: current?.lastActivityAt ?? task.updatedAt,
      secondaryActions: [
        {
          id: task.stage === "backlog" ? "move-todo" : "move-backlog",
          label: task.stage === "backlog" ? "Move to Todo" : "Move to Backlog",
          disabledReason: disabled(
            state,
            task.stage === "backlog" ||
              [
                "todo",
                "planning",
                "plan_approval",
                "in_progress",
                "ci",
                "in_review",
                "awaiting_approval",
              ].includes(task.stage)
              ? null
              : "This stage cannot be moved by hand",
          ),
          command: () => ({
            type: "move",
            to: task.stage === "backlog" ? "todo" : "backlog",
          }),
        },
        {
          id: "cancel",
          label: "Cancel issue",
          disabledReason: disabled(
            state,
            ["done", "canceled"].includes(task.stage)
              ? "Completed issues cannot be canceled"
              : null,
          ),
          command: (text = "") => ({
            type: "cancel",
            reason: text,
          }),
        },
        {
          id: "reopen",
          label: "Reopen issue",
          disabledReason: disabled(
            state,
            task.stage === "canceled"
              ? null
              : "Only canceled issues can be reopened",
          ),
          command: () => ({ type: "reopen" }),
        },
        {
          id: "open-terminal",
          label: "Open terminal",
          disabledReason: terminal ? null : "No live terminal is available",
          intent: "terminal",
        },
        ...(task.prNumber
          ? [
              {
                id: "open-pr",
                label: `Open PR #${task.prNumber}`,
                disabledReason: null,
                intent: "pull-request" as const,
              },
            ]
          : []),
      ],
    },
  };
  cache = {
    tasks,
    runs,
    inbox: state.inbox,
    questions,
    plans,
    connection: state.connection,
    task,
    result,
  };
  return result;
}

export function issueEditActions(ctx: StoreContext) {
  /**
   * Cards dropped on a column but not yet republished, with the task version they were dropped at.
   * The board shows them in the new column at once; the coordinator's next version of the task
   * replaces the move, and a refusal puts the card back.
   */
  const moves = new Map<TaskId, { to: Stage; version: number }>();
  const withPendingMoves = (snapshot: State["snapshot"]): State["snapshot"] => {
    if (!moves.size) return snapshot;
    let changed = false;
    const tasks = snapshot.tasks.map((task) => {
      const move = moves.get(task.id);
      if (!move) return task;
      if (task.version !== move.version) {
        moves.delete(task.id);
        return task;
      }
      if (task.stage === move.to) return task;
      changed = true;
      return { ...task, stage: move.to };
    });
    return changed ? { ...snapshot, tasks } : snapshot;
  };
  const setSnapshot = (snapshot: State["snapshot"]) => {
    ctx.set({ ...ctx.get(), snapshot });
    ctx.emit();
  };
  const actions = {
    moveTask(id: TaskId, to: Stage) {
      const state = ctx.get();
      if (ctx.live) {
        if (to !== "backlog" && to !== "todo") {
          ctx.toast("The coordinator controls this stage.");
          return;
        }
        const task = state.snapshot.tasks.find((item) => item.id === id);
        if (!task || task.stage === to) return;
        const from = task.stage;
        const dropped = { to, version: task.version };
        moves.set(id, dropped);
        setSnapshot(withPendingMoves(state.snapshot));
        void ctx
          .command({
            kind: "human",
            taskId: id,
            command: { type: "move", to },
          })
          .then((outcome) => {
            if (outcome.ok || moves.get(id) !== dropped) return;
            moves.delete(id);
            const current = ctx.get();
            setSnapshot({
              ...current.snapshot,
              tasks: current.snapshot.tasks.map((item) =>
                item.id === id && item.version === dropped.version
                  ? { ...item, stage: from }
                  : item,
              ),
            });
          });
        return;
      }
      const task = state.snapshot.tasks.find((item) => item.id === id);
      if (!task || task.stage === to) return;
      const at = minutesBefore(0);
      setSnapshot({
        ...state.snapshot,
        tasks: state.snapshot.tasks.map((item) =>
          item.id === id
            ? {
                ...item,
                stage: to,
                stageEnteredAt: at,
                updatedAt: at,
                version: item.version + 1,
              }
            : item,
        ),
        transitions: [
          ...state.snapshot.transitions,
          {
            id: transitionId(`${id}-tm${state.snapshot.transitions.length}`),
            taskId: id,
            at,
            from: task.stage,
            to,
            flags: {},
            trigger: {
              kind: "human",
              command: "move",
              inputId: inputId(`ui-${Date.now()}`),
            },
            reason: "Moved by hand in the window.",
            taskVersion: task.version + 1,
          },
        ],
      });
    },
    setFindingStatus(id: string, status: FindingStatus) {
      const state = ctx.get();
      if (ctx.live) {
        ctx.toast("This action is not available in the live Tracker yet.");
        return;
      }
      setSnapshot({
        ...state.snapshot,
        findings: state.snapshot.findings.map(
          (finding): Finding =>
            finding.id === id
              ? { ...finding, status, updatedAt: minutesBefore(0) }
              : finding,
        ),
      });
    },
    addComment(findingId: string, body: string) {
      const state = ctx.get();
      if (ctx.live) {
        ctx.toast("This action is not available in the live Tracker yet.");
        return;
      }
      if (body.trim() === "") return;
      const comment: Comment = {
        id: `c-${findingId}-${state.snapshot.comments.length}`,
        findingId,
        author: "you",
        body: body.trim(),
        at: minutesBefore(0),
      };
      setSnapshot({
        ...state.snapshot,
        comments: [...state.snapshot.comments, comment],
      });
    },
    toggleViewed(task: TaskId, path: string) {
      const state = ctx.get();
      if (ctx.live) {
        ctx.toast("This action is not available in the live Tracker yet.");
        return;
      }
      const current = state.snapshot.viewedFiles[task] ?? [];
      const next = current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path];
      setSnapshot({
        ...state.snapshot,
        viewedFiles: { ...state.snapshot.viewedFiles, [task]: next },
      });
    },
    createTask(
      title: string,
      repo: string,
      options: {
        name?: string | null;
        description?: string;
        size?: Task["size"];
        requirePlanApproval?: boolean;
      } = {},
    ) {
      const state = ctx.get();
      if (ctx.live) {
        ctx.toast("This action is not available in the live Tracker yet.");
        return;
      }
      const at = minutesBefore(0);
      const id = `LOOM-${state.snapshot.tasks.length + 101}` as TaskId;
      const roles = state.settings.find(
        (settings) =>
          settings.scope.kind === "repository" &&
          settings.scope.repoId === repo,
      )?.effective.roles;
      const task: Task = {
        id,
        repoId: repo as Task["repoId"],
        number: state.snapshot.tasks.length + 101,
        name: options.name ?? null,
        title,
        description: options.description ?? "",
        summary: null,
        stage: "backlog",
        stageEnteredAt: at,
        version: 1,
        blocked: null,
        failed: null,
        requirePlanApproval: options.requirePlanApproval ?? true,
        reviewRound: 0,
        reviewRoundCap: 3,
        providers: roles
          ? {
              planner: roles.planner.provider,
              implementer: roles.implementer.provider,
              reviewer: roles.reviewer.provider,
            }
          : {
              planner: "codex",
              implementer: "claude",
              reviewer: "codex",
            },
        blockedBy: [],
        budgetMinutes: null,
        size: options.size ?? "normal",
        createdAt: at,
        updatedAt: at,
        worktreePath: null,
        branch: null,
        prNumber: null,
        attention: { reasons: [], reasonSince: {}, since: null },
      };
      setSnapshot({
        ...state.snapshot,
        tasks: [task, ...state.snapshot.tasks],
      });
      ctx.setUi({ cursor: 0, openTask: id });
      return id;
    },
  };
  return { actions, withPendingMoves };
}
