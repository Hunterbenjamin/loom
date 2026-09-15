import type {
  Approval,
  Artifact,
  Finding,
  FindingAnchor,
  FindingLocation,
  Message,
  Question,
  Repo,
  Run,
  Task,
  TaskState,
  Transition,
  Worktree,
} from "@loom/core";
import { storedEntities } from "@loom/protocol";
import { contract } from "./schema-helpers.js";

export const repoSchema = contract<Repo>()(storedEntities.repo);
export const taskSchema = contract<Task>()(storedEntities.task);
export const worktreeSchema = contract<Worktree>()(storedEntities.worktree);
export const runSchema = contract<Run>()(storedEntities.run);
export const messageSchema = contract<Message>()(storedEntities.message);
export const questionSchema = contract<Question>()(storedEntities.question);
export const artifactSchema = contract<Artifact>()(storedEntities.artifact);
export const anchorSchema = contract<FindingAnchor>()(
  storedEntities.findingAnchor,
);
export const locationSchema = contract<FindingLocation>()(
  storedEntities.findingLocation,
);
export const findingSchema = contract<Finding>()(storedEntities.finding);
export const approvalSchema = contract<Approval>()(storedEntities.approval);
export const transitionSchema = contract<Transition>()(
  storedEntities.transition,
);
export const planSchema = storedEntities.plan;
type TaskContext = Pick<
  TaskState,
  | "plan"
  | "review"
  | "ciGate"
  | "desiredRun"
  | "activeElapsedMs"
  | "budgetObservedAt"
  | "progress"
>;
export const contextSchema = contract<TaskContext>()(
  storedEntities.taskContext,
);
