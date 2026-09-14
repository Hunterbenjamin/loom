// Test-only action dispatcher. This deliberately is not exported as a coordinator executor.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ActionResult,
  ProviderSessionId,
  Sha,
  Stage,
  WorktreePath,
} from "@loom/core";
import { createGitAdapter } from "../../adapters/git/src/index.js";
import { fixture } from "../../core/test/fixtures.js";
import {
  createFakeAdapters,
  FakeClock,
  observeFakes,
  type ScenarioOptions,
} from "./index.js";

const exec = promisify(execFile);
export async function setup(stage: Stage = "todo", withPr = true) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "loom-fake-agent-")),
  );
  const cwd = root as WorktreePath;
  const git = async (...args: string[]) =>
    (
      await exec("git", args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
          GIT_AUTHOR_DATE: "2026-09-12T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-09-12T00:00:00Z",
        },
      })
    ).stdout.trim();
  await git("init", "-b", "main");
  await writeFile(join(root, "example.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "Base");
  const base = (await git("rev-parse", "HEAD")) as Sha;
  await git("checkout", "-b", "feat/fake");
  await writeFile(join(root, "example.txt"), "initial\n");
  await git("add", ".");
  await git("commit", "-m", "Initial change");
  let remote = (await git("rev-parse", "HEAD")) as Sha;
  const { state, observations } = fixture(stage);
  state.config = {
    ...state.config,
    sha256: (s) => createHash("sha256").update(s).digest("hex"),
    // These deterministic transport scenarios intentionally exercise the opt-in headless path.
    runModes: {
      planner: "headless",
      implementer: "headless",
      reviewer: "headless",
    },
  };
  state.runs = [];
  state.task.branch = "feat/fake";
  state.task.worktreePath = cwd;
  state.task.reviewRound = 0;
  if (state.worktree)
    Object.assign(state.worktree, {
      path: cwd,
      branch: "feat/fake",
      baseSha: base,
    });
  state.review = {
    headSha: remote,
    lastReviewedHead: remote,
    previousBlocking: null,
    verdictIds: [],
  };
  const clock = new FakeClock();
  const initial =
    withPr && observations.github?.ok ? observations.github.value : null;
  if (!withPr) state.task.prNumber = null;
  if (initial) {
    initial.headSha = remote;
    initial.ci.headSha = remote;
  }
  const adapters = createFakeAdapters(clock, state, initial);
  const gitAdapter = createGitAdapter();
  const options: Omit<ScenarioOptions, "scenarios"> = {
    state,
    clock,
    adapters,
    observe: async (runner) => {
      const candidates = runner.state.findings.flatMap((f) =>
        f.resolution?.commitSha ? [f.resolution.commitSha] : [],
      );
      const observation = await gitAdapter.readWorktree(
        cwd,
        "main",
        [(await git("rev-parse", "HEAD")) as Sha, ...candidates],
        runner.state.review?.headSha,
      );
      observation.remoteHeadSha = remote;
      return observeFakes(runner, observation);
    },
    commit: async (step) => {
      for (const [path, contents] of Object.entries(step.files)) {
        const target = resolve(root, path);
        if (
          !target.startsWith(`${root}/`) ||
          target.startsWith(`${root}/.git/`)
        )
          throw new Error("Unsafe fixture path");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      if (step.writeOnly) return;
      await git("add", ".");
      await git("commit", "-m", step.message);
      if (step.human) {
        remote = (await git("rev-parse", "HEAD")) as Sha;
        adapters.github.setHead(remote);
      }
    },
    onAction: async (action, runner) => {
      let output: unknown = {};
      switch (action.kind) {
        case "start_run": {
          const id =
            action.sessionId ??
            (`fake-${action.runId}-${action.sessionEpoch}` as ProviderSessionId);
          const exists = adapters.providers.sessions.has(id);
          adapters.providers.create(action.provider, cwd, id, action.mode);
          if (exists && action.resume) adapters.providers.recover(id);
          output = {
            sessionId: id,
            codexGeneration:
              action.provider === "codex" ? adapters.codex.generation() : null,
            pane: null,
          };
          break;
        }
        case "send_message": {
          const run = runner.state.runs.find((r) => r.id === action.runId);
          if (!run?.sessionId) throw new Error("Run has no recorded session");
          if (action.via === "codex_turn_start")
            output = {
              transportRef: (
                await adapters.codex.startTurn({
                  threadId: run.sessionId,
                  text: action.text,
                })
              ).turnId,
            };
          else if (action.via === "codex_turn_steer")
            output = {
              transportRef: (
                await adapters.codex.steerTurn({
                  threadId: run.sessionId,
                  text: action.text,
                  expectedTurnId: action.expectedTurnId ?? "",
                })
              ).turnId,
            };
          else {
            adapters.providers.enqueue(run.sessionId, action.text);
            output = { transportRef: null };
          }
          break;
        }
        case "push_branch":
          remote = action.expectedHeadSha;
          adapters.github.setHead(remote);
          output = { remoteHeadSha: remote };
          break;
        case "open_pr":
          output = await adapters.github.openPullRequest({
            repo: action.repoId,
            branch: action.branch,
            baseBranch: action.baseBranch,
            title: action.title,
            body: action.body,
          });
          break;
        case "merge_pr":
          output = await adapters.github.mergePullRequest({
            repo: action.repoId,
            number: action.prNumber,
            matchHeadSha: action.matchHeadSha,
            auto: action.auto,
          });
          break;
        case "disable_auto_merge":
          await adapters.github.disableAutoMerge({
            repo: action.repoId,
            number: action.prNumber,
          });
          break;
        case "map_findings":
          output = { locations: [] };
          break;
        case "open_workspace":
          output = await adapters.paneHost.ensureWorkspace({
            taskId: action.taskId,
            cwd,
            label: action.label,
          });
          break;
        case "create_worktree":
          throw new Error("Fixture already has a worktree");
        case "remove_worktree":
          output = { removed: true };
          break;
        case "answer_provider_request": {
          const run = runner.state.runs.find((r) => r.id === action.runId);
          if (!run?.sessionId) throw new Error("No session");
          await adapters.codex.answerRequest({
            ...action,
            threadId: run.sessionId,
            generation: action.generation ?? 0,
          });
          break;
        }
      }
      return { kind: action.kind, ok: true, output } as ActionResult;
    },
  };
  return {
    ...options,
    options,
    git,
    cwd,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
