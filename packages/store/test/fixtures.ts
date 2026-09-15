import { createHash } from "node:crypto";
import type {
  Action,
  ActionKey,
  Artifact,
  Input,
  InputId,
  IsoTime,
  ReconcileConfig,
  ReconcileResult,
  Repo,
  RepoId,
  Task,
  TaskId,
  TaskState,
  WorktreePath,
} from "@loom/core";
import {
  config as coreConfig,
  finding as coreFinding,
  fixture as coreFixture,
  run as coreRun,
} from "../../core/test/fixtures.js";

export const now = "2026-09-12T00:00:00.000Z" as IsoTime;
export const taskId = "t1" as TaskId;
export const config: ReconcileConfig = {
  ...coreConfig,
  sha256: (v) => createHash("sha256").update(v).digest("hex"),
};
export const repo: Repo = {
  id: "repo" as RepoId,
  root: "/tmp/loom-store-fixture" as WorktreePath,
  github: "example/fixture",
};
export function task(id = taskId): Task {
  return {
    ...coreFixture("backlog").state.task,
    id,
    version: 0,
    worktreePath: null,
    branch: null,
    prNumber: null,
    reviewRound: 0,
  };
}
export function artifact(
  state: TaskState,
  kind: Artifact["kind"],
  content: unknown,
): void {
  const previous = state.artifacts.find((a) => a.kind === kind);
  const version = (previous?.version ?? 0) + 1;
  const metadata: Artifact = {
    id: `${state.task.id}/${kind}/${version}` as Artifact["id"],
    taskId: state.task.id,
    kind,
    version,
    path: `tasks/${state.task.id}/${kind}/v${version}.json`,
    sha256: config.sha256(JSON.stringify(content)),
    createdBy: "coordinator",
    createdAt: now,
  };
  state.artifacts = [
    ...state.artifacts.filter((a) => a.kind !== kind),
    metadata,
  ];
  state.artifactContents[kind] = content;
}
export function richState(): TaskState {
  const state = coreFixture().state;
  state.config = config;
  state.issueKey = "FIXTURE-1";
  state.task.version = 1;
  state.task.attention = {
    reasons: ["question"],
    reasonSince: { question: now },
    since: now,
  };
  state.runs = [
    coreRun("planner"),
    {
      ...coreRun(),
      status: "working",
      unknownSince: null,
      observedAttempt: 1,
      retryBaseAttempt: 0,
    },
    coreRun("reviewer", "claude"),
  ];
  state.messages = [
    {
      id: "message-1" as never,
      runId: required(state.runs[1]).id,
      purpose: "human",
      text: "Continue",
      textHash: config.sha256("Continue"),
      status: "sent",
      attempts: 1,
      transportRef: "turn-1",
      sentAt: now,
      delivered: null,
      via: "codex_turn_steer",
      expectedTurnId: "turn-1",
      baselineTurnId: "turn-0",
      deliveryAttention: false,
    },
  ];
  state.questions = [
    {
      id: "question-1" as never,
      taskId,
      runId: required(state.runs[1]).id,
      question: "Which mode?",
      options: ["One", "Two"],
      blocking: true,
      askedAt: now,
      answer: null,
      answeredAt: null,
    },
  ];
  state.findings = [coreFinding()];
  state.approvals = [
    {
      id: "approval-1" as never,
      taskId,
      kind: "plan",
      planVersion: 1,
      createdAt: now,
      voidedAt: null,
      voidReason: null,
    },
  ];
  state.desiredRun = { role: "reviewer", round: 2, resume: false };
  state.activeElapsedMs = 12345;
  state.progress = {
    runId: required(state.runs[1]).id,
    summary: "Implemented the first step",
    stepIndex: 0,
    at: now,
  };
  artifact(state, "plan", state.plan);
  artifact(state, "findings", state.findings);
  return state;
}
export function input(id = "input-1"): Input {
  return {
    id: id as InputId,
    receivedAt: now,
    type: "human",
    command: { type: "retry" },
  };
}
export function result(next: TaskState): ReconcileResult {
  return { next, actions: [], inputs: [], transitions: [] };
}
export function notify(
  state: TaskState,
  key = "notify-1",
  dependsOn: ActionKey[] = [],
): Action {
  const action: Action = {
    kind: "notify",
    taskId: state.task.id,
    key: key as ActionKey,
    level: "info",
    title: "Task update",
    body: "Ready",
  };
  state.outbox.push({
    key: action.key,
    kind: action.kind,
    action,
    status: "pending",
    attempts: 0,
    createdAt: now,
    finishedAt: null,
    dependsOn,
  });
  return action;
}

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing test fixture value");
  return value;
}
