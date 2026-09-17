import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo, RepoId } from "@loom/core";
import type { RepoFileStatus, RepoFiles } from "@loom/protocol";
import type { Handlers } from "./commands.js";
import type { TaskInputs } from "./task-inputs.js";
import type { WorkflowReader } from "./workflow.js";

/** Disposable projection: the registered repository owns these files. */
export async function checkRepoFiles(
  root: string,
  workflow: WorkflowReader,
): Promise<RepoFiles> {
  const instruction = async (
    file: "AGENTS.md" | "CLAUDE.md",
  ): Promise<RepoFileStatus> => {
    try {
      await readFile(join(root, file), "utf8");
      return { file, status: "present" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { file, status: "missing" }
        : { file, status: "unusable", reason: String(error) };
    }
  };
  const [agents, claude, result] = await Promise.all([
    instruction("AGENTS.md"),
    instruction("CLAUDE.md"),
    workflow.inspect(root),
  ]);
  return [
    agents,
    claude,
    {
      file: "WORKFLOW.md",
      status: result.status,
      ...(result.status === "unusable" ? { reason: result.reason } : {}),
    },
  ];
}

async function draftDescription(files: RepoFiles): Promise<string> {
  const targets = files.filter((file) => file.status !== "present");
  // Embed the canonical templates: the target project need not have Loom's own docs.
  const guide = await readFile(
    new URL("../../../docs/using-loom.md", import.meta.url),
    "utf8",
  );
  const templates = targets.map(({ file }) => {
    const start = `<!-- loom-template:${file}:start -->`;
    const end = `<!-- loom-template:${file}:end -->`;
    const afterStart = guide.split(start)[1];
    if (!afterStart?.includes(end))
      throw new Error(`Missing onboarding template for ${file}`);
    const section = afterStart.split(end)[0];
    return `### ${file}\n${section?.trim()}`;
  });
  return [
    "Draft repository instructions and workflow commands in this issue's isolated worktree, delivered as a PR for the human to review and merge.",
    "## Files to draft or repair",
    ...targets.map(
      ({ file, status, reason }) =>
        `- ${file}: ${status}${reason ? ` — ${reason}` : ""}`,
    ),
    "Inspect the package manager, scripts, test runner, source layout and existing documentation. Adapt the templates to facts found in this repository; omit unsupported commands and conventions. Preserve existing usable files. Never write into the registered checkout or merge the PR. Describe the resulting files and validation in the PR.",
    "## Templates from Loom's docs/using-loom.md (LOOM-137)",
    ...templates,
  ].join("\n\n");
}

export function onboardingHandlers(deps: {
  repos(): Repo[];
  workflow: WorkflowReader;
  taskInputs: TaskInputs;
}): Handlers<"check_repo_files" | "start_repo_onboarding"> {
  const repo = (id: RepoId) => {
    const found = deps.repos().find((item) => item.id === id);
    if (!found)
      throw Object.assign(new Error(`Unknown repository ${id}`), {
        code: "invalid_input",
      });
    return found;
  };
  return {
    check_repo_files: async ({ repoId }) => ({
      ok: true,
      result: {
        kind: "repo_files",
        repoId,
        files: await checkRepoFiles(repo(repoId).root, deps.workflow),
      },
    }),
    start_repo_onboarding: async ({ repoId }) => {
      const files = await checkRepoFiles(repo(repoId).root, deps.workflow);
      if (files.every((file) => file.status === "present"))
        return {
          ok: false,
          error: {
            code: "guard_failed",
            message: "All three repository files are present and usable",
            details: [],
          },
        };
      const description = await draftDescription(files);
      const { task } = deps.taskInputs.createTask({
        repoId,
        title: "Draft repository instructions and workflow commands",
        description,
        mergePolicy: "require-human",
      });
      const inputId = deps.taskInputs.submitHuman(task.id, {
        type: "move",
        to: "todo",
      });
      const decision = await deps.taskInputs.decision(task.id, inputId);
      if (!decision.accepted) return { ok: false, error: decision.error };
      return { ok: true, result: { kind: "task_created", taskId: task.id } };
    },
  };
}
