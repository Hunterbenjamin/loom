import type { Repo, Task } from "@loom/core";
import { command } from "@loom/protocol";
import type { Store } from "@loom/store";
import { describe, expect, it } from "vitest";
import { fixture } from "../../../packages/core/test/fixtures.js";
import { repo as fixtureRepo } from "../../../packages/store/test/fixtures.js";
import { resolveCommandTaskRefs } from "./task-refs.js";

const issue: Task = { ...fixture("backlog").state.task, number: 12 };
const repo: Repo = { ...fixtureRepo, id: issue.repoId, github: "owner/loom" };
const store = {
  tasks: () => [issue],
  repos: () => [repo],
} as Store;

describe("resolveCommandTaskRefs", () => {
  it("rewrites command task references once at the boundary", () => {
    const result = resolveCommandTaskRefs(
      command.parse({
        kind: "human",
        taskId: "loom-12",
        command: { type: "move", to: "todo" },
      }),
      store,
    );
    expect(result).toMatchObject({ ok: true, command: { taskId: issue.id } });
  });

  it("resolves dependencies in the task's repository", () => {
    const result = resolveCommandTaskRefs(
      command.parse({
        kind: "create_task",
        repoId: repo.id,
        title: "Dependent",
        name: null,
        description: "",
        summary: null,
        providers: null,
        requirePlanApproval: null,
        blockedBy: ["12"],
        budgetMinutes: null,
        size: null,
      }),
      store,
    );
    expect(result).toMatchObject({
      ok: true,
      command: { blockedBy: [issue.id] },
    });
  });

  it("maps unknown references to the protocol error", () => {
    expect(
      resolveCommandTaskRefs(
        command.parse({
          kind: "open_task_terminal",
          taskId: "LOOM-99",
        }),
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: "unknown_task" } });
  });
});
