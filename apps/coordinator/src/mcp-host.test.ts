import type { Repo } from "@loom/core";
import type { Store } from "@loom/store";
import { expect, test } from "vitest";
import { finding, fixture } from "../../../packages/core/test/fixtures.js";
import type { Adapters } from "./adapters.js";
import { createMcpHost } from "./mcp-host.js";
import type { RecipeStore } from "./recipes.js";

const setup = (role: "implementer" | "reviewer" = "implementer") => {
  const { state, observations } = fixture(
    role === "reviewer" ? "in_review" : "in_progress",
  );
  const run = state.runs.find((candidate) => candidate.role === role);
  const git = observations.git;
  if (!run || !git?.ok) throw new Error("Missing fixture run");
  const host = createMcpHost({
    store: {
      loadTaskState: () => state,
    } as unknown as Store,
    adapters: {
      git: {
        readWorktree: async () => git.value,
      },
    } as unknown as Adapters,
    recipes: {
      get: () => ({ taskId: state.task.id }),
    } as unknown as RecipeStore,
    loop: {} as never,
    workflow: { read: async () => ({ test: "pnpm test" }) },
    repo: () => ({ root: "/repo" }) as Repo,
  }).host;
  return { host, run, state };
};

test("context reads are full first, lean on repeat, forced full, and full after an epoch bump", async () => {
  const { host, run } = setup();
  expect(await host.context(run.id, {})).toMatchObject({ view: "full" });
  const repeat = await host.context(run.id, {});
  expect(repeat).toEqual({
    view: "changes",
    header: expect.any(Object),
    mustAct: [],
  });
  expect(await host.context(run.id, { full: true })).toMatchObject({
    view: "full",
  });
  run.sessionEpoch++;
  expect(await host.context(run.id, {})).toMatchObject({ view: "full" });
});

test("reviewer context keeps role filtering in full and changes views", async () => {
  const { host, run, state } = setup("reviewer");
  state.findings = [
    finding("hidden", { source: "reviewer", status: "addressed" }),
    finding("visible", { source: "human", status: "disputed" }),
  ];
  const initial = await host.context(run.id, {});
  if (initial.view !== "full") throw new Error("Expected a full view");
  expect(initial.findings.map((item) => item.id)).toEqual(["visible"]);
  const repeat = await host.context(run.id, {});
  expect(repeat).toMatchObject({
    view: "changes",
    mustAct: [{ id: "visible", title: "Fix bug", status: "disputed" }],
  });
  expect(repeat).not.toHaveProperty("findings");
});
