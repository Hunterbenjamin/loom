import { ROLE_VALUES } from "@loom/core";
// Task creation and human inputs shared by the coordinator API and protocol commands.
import { randomUUID } from "node:crypto";
import type {
  Attention,
  HumanCommand,
  Input,
  InputDisposition,
  InputId,
  IsoTime,
  Repo,
  RepoId,
  Task,
  TaskId,
  TaskState,
} from "@loom/core";
import type { Store } from "@loom/store";
import type { CoordinatorConfig } from "./config.js";
import type { Loop } from "./loop.js";
import type { CoordinatorSettings } from "./settings.js";
import type { CreateTaskInput } from "./task-commands.js";

interface TaskInputDeps {
  store: Store;
  config: CoordinatorConfig;
  settings: CoordinatorSettings;
  loop: Loop;
  repoById(id: RepoId): Repo;
  now(): IsoTime;
  log(message: string): void;
}

const EMPTY_ATTENTION: Attention = {
  reasons: [],
  reasonSince: {},
  since: null,
};

export class TaskInputs {
  constructor(private readonly deps: TaskInputDeps) {}

  createTask(input: CreateTaskInput): TaskState {
    const repo = this.deps.repoById(input.repoId);
    const settings = this.deps.settings.effective(repo.id);
    const now = this.deps.now();
    const id = `t-${randomUUID().slice(0, 8)}` as TaskId;
    const task: Omit<Task, "number"> = {
      id,
      repoId: repo.id,
      name: input.name ?? null,
      title: input.title,
      description: input.description,
      summary: input.summary ?? null,
      stage: "backlog",
      stageEnteredAt: now,
      version: 0,
      blocked: null,
      failed: null,
      requirePlanApproval:
        input.requirePlanApproval ?? settings.workflow.requirePlanApproval,
      mergePolicy: settings.workflow.mergePolicy,
      reviewRound: 0,
      reviewRoundCap: settings.workflow.reviewRoundCap,
      roleProfiles: Object.fromEntries(
        ([...ROLE_VALUES]).map((role) => {
          const profile = settings.roles[role];
          const provider = input.providers?.[role] ?? profile.provider;
          return [
            role,
            provider === profile.provider
              ? profile
              : {
                  ...profile,
                  provider,
                  model: this.deps.config.models[provider],
                  reasoningEffort:
                    provider === "codex"
                      ? (this.deps.config.codexReasoningEffort ?? "medium")
                      : null,
                },
          ];
        }),
      ) as Task["roleProfiles"],
      providers: {
        planner: input.providers?.planner ?? settings.roles.planner.provider,
        implementer:
          input.providers?.implementer ?? settings.roles.implementer.provider,
        reviewer: input.providers?.reviewer ?? settings.roles.reviewer.provider,
      },
      blockedBy: input.blockedBy ?? [],
      budgetMinutes: input.budgetMinutes ?? settings.workflow.budgetMinutes,
      size: input.size ?? settings.workflow.size,
      createdAt: now,
      updatedAt: now,
      worktreePath: null,
      branch: null,
      prNumber: null,
      attention: EMPTY_ATTENTION,
    };
    const state = this.deps.store.createTask(task);
    this.deps.loop.enqueue(id);
    return state;
  }

  /**
   * A human command becomes an input; reconcile decides what it means (principle 3). It is decided
   * at once against the task's last readings when it can be (design §5.1a), and a pass follows.
   */
  submitHuman(taskId: TaskId, command: HumanCommand): InputId {
    const started = performance.now();
    const input: Input = {
      id: randomUUID() as InputId,
      receivedAt: this.deps.now(),
      type: "human",
      command,
    };
    this.deps.store.enqueueInput(taskId, input);
    const applied = this.deps.loop.applyHuman(taskId);
    if (applied)
      this.deps.log(
        `${command.type} for ${taskId} decided in ${(performance.now() - started).toFixed(1)} ms`,
      );
    return input.id;
  }

  /**
   * What reconcile decided about an input. Decided inputs answer at once; otherwise (no readings
   * yet in this process, or an agent's input first in line) this runs the passes that decide it.
   */
  async decision(taskId: TaskId, inputId: InputId): Promise<InputDisposition> {
    for (let pass = 0; pass < 50; pass++) {
      const disposition = this.deps.store.inputDisposition(taskId, inputId);
      if (disposition) return disposition;
      await this.deps.loop.pass(taskId);
    }
    throw new Error(`Input ${inputId} was queued but not consumed`);
  }
}
