import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadScenarios } from "@loom/fake-agent";
import { repoId } from "@loom/protocol";
import { afterEach, expect, test } from "vitest";
import { LoomClient } from "./client.js";
import { checkRepoFiles } from "./onboarding.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";
import { createWorkflowReader } from "./workflow.js";

const harnesses: Harness[] = [];
const clients: LoomClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const h of harnesses.splice(0)) await h.close();
});
const workflowText = "## test\n\n```sh\nnpm test\n```\n";
async function setup(files: Record<string, string> = {}) {
  const h = await createHarness({ serveProtocol: true, files });
  harnesses.push(h);
  const client = await LoomClient.connect({
    url: h.coordinator.protocol.url as string,
    token: h.config.token,
    clientId: "onboarding-test",
    kind: "cli",
    subscriptions: [],
  });
  clients.push(client);
  return { h, client };
}

test("projection distinguishes missing, unreadable, parse failures and prose without grading", async () => {
  const { h } = await setup();
  const warnings: string[] = [];
  const workflow = createWorkflowReader((message) => warnings.push(message));
  expect(await workflow.inspect(h.repoRoot)).toEqual({
    status: "missing",
    commands: {},
  });
  expect(
    (await checkRepoFiles(h.repoRoot, workflow)).map((file) => file.status),
  ).toEqual(["missing", "missing", "missing"]);
  await writeFile(join(h.repoRoot, "AGENTS.md"), "");
  await mkdir(join(h.repoRoot, "CLAUDE.md"));
  await writeFile(join(h.repoRoot, "WORKFLOW.md"), workflowText.repeat(2));
  expect(await checkRepoFiles(h.repoRoot, workflow)).toEqual([
    { file: "AGENTS.md", status: "present" },
    { file: "CLAUDE.md", status: "unusable", reason: expect.any(String) },
    {
      file: "WORKFLOW.md",
      status: "unusable",
      reason: "WORKFLOW.md defines test twice",
    },
  ]);
  expect(await workflow.read(h.repoRoot)).toEqual({});
  expect(warnings).toHaveLength(1);
  await writeFile(join(h.repoRoot, "WORKFLOW.md"), workflowText);
  expect(await workflow.read(h.repoRoot)).toEqual({ test: "npm test" });
  const time = new Date("2026-01-01T00:00:00Z");
  await utimes(join(h.repoRoot, "WORKFLOW.md"), time, time);
  await workflow.read(h.repoRoot);
  await writeFile(
    join(h.repoRoot, "WORKFLOW.md"),
    workflowText.replace("npm test", "npm lint"),
  );
  await utimes(join(h.repoRoot, "WORKFLOW.md"), time, time);
  expect(await workflow.read(h.repoRoot)).toEqual({ test: "npm lint" });
});

test("protocol checks unknown repositories and fresh complete files without creating an issue", async () => {
  const { h, client } = await setup({ "WORKFLOW.md": workflowText });
  for (const kind of ["check_repo_files", "start_repo_onboarding"] as const) {
    expect(
      await client.command({ kind, repoId: repoId.parse("unknown") }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  }
  expect(
    await client.command({ kind: "check_repo_files", repoId: h.repo.id }),
  ).toMatchObject({
    ok: true,
    result: {
      files: [
        { file: "AGENTS.md", status: "missing" },
        { file: "CLAUDE.md", status: "missing" },
        { file: "WORKFLOW.md", status: "present" },
      ],
    },
  });
  for (const file of ["AGENTS.md", "CLAUDE.md"])
    await writeFile(join(h.repoRoot, file), "Thin but usable\n");
  const check = await client.command({
    kind: "check_repo_files",
    repoId: h.repo.id,
  });
  expect(check).toMatchObject({
    ok: true,
    result: {
      files: [
        { status: "present" },
        { status: "present" },
        { status: "present" },
      ],
    },
  });
  expect(
    await client.command({ kind: "start_repo_onboarding", repoId: h.repo.id }),
  ).toMatchObject({ ok: false, error: { code: "guard_failed" } });
  expect(h.store.tasks()).toHaveLength(0);
});

test("a parser-rejected workflow gets a repair issue with the canonical template", async () => {
  const { h, client } = await setup({
    "AGENTS.md": "Rules",
    "CLAUDE.md": "@AGENTS.md",
    "WORKFLOW.md": workflowText.repeat(2),
  });
  expect(
    await client.command({ kind: "start_repo_onboarding", repoId: h.repo.id }),
  ).toMatchObject({ ok: true, result: { kind: "task_created" } });
  const task = h.store.tasks()[0];
  if (!task) throw new Error("Missing drafting issue");
  expect(
    h.store.transitions(task.id).map((transition) => transition.to),
  ).toContain("todo");
  expect(task.description).toContain("WORKFLOW.md defines test twice");
  expect(task.description).toContain("npm ci");
});

test("Hunterbenjamin-loom-sandbox shape drafts AGENTS.md and CLAUDE.md through the ordinary PR pipeline", async () => {
  const { h, client } = await setup({ "WORKFLOW.md": workflowText });
  const settings = h.store.settings.read({
    kind: "repository",
    repoId: h.repo.id,
  });
  await client.command({
    kind: "update_settings",
    scope: { kind: "repository", repoId: h.repo.id },
    expectedVersion: settings.version,
    patch: { workflow: { mergePolicy: "auto-all" } },
  });
  const result = await client.command({
    kind: "start_repo_onboarding",
    repoId: h.repo.id,
  });
  if (!result.ok || result.result.kind !== "task_created")
    throw new Error(JSON.stringify(result));
  expect(h.store.tasks()).toHaveLength(1);
  const task = h.store.loadTaskState(result.result.taskId).task;
  expect(task).toMatchObject({
    repoId: h.repo.id,
    mergePolicy: "require-human",
  });
  expect(task.description).toContain("AGENTS.md: missing");
  expect(task.description).toContain("CLAUDE.md: missing");
  expect(task.description).not.toContain("WORKFLOW.md");
  expect(task.description).toContain("@AGENTS.md");
  expect(task.providers).toEqual({
    planner: "claude",
    implementer: "codex",
    reviewer: "claude",
  });

  const scenarios = await loadScenarios(
    new URL("./fixtures/walking-skeleton.json", import.meta.url),
  );
  const planner = scenarios[0];
  const implementer = scenarios[1];
  const reviewer = scenarios[3];
  if (!planner || !implementer || !reviewer)
    throw new Error("Missing scenario");
  const files = {
    "AGENTS.md":
      "# Project instructions\n\nThis sandbox has example.txt and WORKFLOW.md. Run npm test as recorded in WORKFLOW.md. Never commit credentials or change production data.\n",
    "CLAUDE.md": "@AGENTS.md\n",
  };
  for (const step of planner.steps)
    if ("tool" in step && step.tool === "submit_plan")
      step.input = {
        plan: {
          goal: "Draft the missing repository instructions",
          nonGoals: ["Change WORKFLOW.md"],
          steps: ["Inspect the sandbox and draft the two missing files"],
          areas: Object.keys(files),
          acceptanceCriteria: ["AGENTS.md and CLAUDE.md are drafted"],
          testPlan: ["Read the draft files"],
          risks: [],
          openQuestions: [],
          suggestedImplementer: null,
        },
      };
  for (const step of implementer.steps) {
    if ("git" in step) {
      step.files = files;
      step.message = "Draft sandbox instructions";
    }
    if ("tool" in step && step.tool === "submit_for_review")
      step.input = {
        headSha: "$HEAD",
        summary: "Drafted AGENTS.md and CLAUDE.md; preserved WORKFLOW.md.",
        testResults: [],
        handoff: {
          summary: "Review the two draft instruction files",
          nextSteps: [],
        },
      };
  }
  for (const step of reviewer.steps)
    if ("tool" in step && step.tool === "submit_review")
      step.input = {
        reviewedSha: "$HEAD",
        reviewerCommits: [],
        summary: "The two drafts follow the templates",
        findings: [],
        verdicts: [],
        testResults: [],
      };
  await new ScenarioDriver(h, [planner, implementer, reviewer]).run();
  await h.coordinator.settle();
  const state = h.store.loadTaskState(task.id);
  expect(state.task.stage).toBe("awaiting_approval");
  expect(state.task.prNumber).toBe(1);
  expect(h.github.snapshot()?.state).not.toBe("merged");
  if (!state.worktree) throw new Error("Missing worktree");
  expect(await h.git("status", "--porcelain")).toBe("");
  for (const [name, content] of Object.entries(files)) {
    await expect(
      readFile(join(h.repoRoot, name), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(state.worktree.path, name), "utf8")).toBe(
      content,
    );
  }
  expect(await readFile(join(state.worktree.path, "WORKFLOW.md"), "utf8")).toBe(
    workflowText,
  );
}, 30_000);
