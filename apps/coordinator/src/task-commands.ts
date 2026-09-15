import type {
  HumanCommand,
  InputDisposition,
  InputId,
  ProviderRules,
  RepoId,
  TaskId,
  TaskState,
} from "@loom/core";
import type { Store } from "@loom/store";
import { type Attachments, withHumanAttachments } from "./attachments.js";
import type { Handlers } from "./commands.js";
import type { RecipeStore } from "./recipes.js";
import { taskRows, type ViewDeps } from "./views.js";

export interface CreateTaskInput {
  repoId: RepoId;
  title: string;
  name?: string | null;
  description: string;
  summary?: string | null;
  providers?: ProviderRules | null;
  requirePlanApproval?: boolean | null;
  blockedBy?: TaskId[];
  budgetMinutes?: number | null;
  size?: "small" | "normal" | null;
}

interface TaskCommandDeps {
  store: Store;
  recipes: RecipeStore;
  attachments: Attachments;
  createTask(input: CreateTaskInput): TaskState;
  submitHuman(taskId: TaskId, command: HumanCommand): InputId;
  decision(taskId: TaskId, inputId: InputId): Promise<InputDisposition>;
  viewDeps(): ViewDeps;
}

type TaskKind = "create_task" | "human" | "open_attach_session";

export function taskHandlers(deps: TaskCommandDeps): Handlers<TaskKind> {
  return {
    create_task: (command) => {
      const state = deps.createTask({
        repoId: command.repoId,
        title: command.title,
        name: command.name ?? null,
        description: command.description,
        summary: command.summary ?? null,
        providers: command.providers ?? null,
        requirePlanApproval: command.requirePlanApproval ?? null,
        blockedBy: command.blockedBy ?? [],
        budgetMinutes: command.budgetMinutes ?? null,
        size: command.size ?? null,
      });
      return {
        ok: true,
        result: { kind: "task_created", taskId: state.task.id },
      };
    },
    human: async (command) => {
      if (!command.taskId || !command.command)
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: "A human command needs a task and a command",
            details: [],
          },
        };
      const human = await withHumanAttachments(
        command.command,
        command.taskId,
        deps.attachments,
        deps.store,
      );
      const inputId = deps.submitHuman(command.taskId, human);
      const disposition = await deps.decision(command.taskId, inputId);
      if (!disposition.accepted) return { ok: false, error: disposition.error };
      return { ok: true, result: { kind: "human", inputId } };
    },
    open_attach_session: async (command) => {
      const recipe = deps.recipes.get(command.runId);
      if (!recipe)
        return {
          ok: false,
          error: {
            code: "unknown_run",
            message: `No run ${command.runId}`,
            details: [],
          },
        };
      const { rows } = await taskRows(deps.viewDeps(), recipe.taskId);
      const target = rows.find(
        (row) => row.collection === "run_target" && row.key === command.runId,
      );
      if (!target)
        return {
          ok: false,
          error: {
            code: "unknown_run",
            message: `Run ${command.runId} has no attach target`,
            details: [],
          },
        };
      return {
        ok: true,
        result: { kind: "attach_session", target: target.value },
      };
    },
  };
}
