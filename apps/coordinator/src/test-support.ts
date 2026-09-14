// The test harness: a real coordinator (loop, executor, MCP server, store, protocol server)
// against `@loom/fake-agent`'s providers, pane host and GitHub, a throwaway Git repository and a
// fake clock. Nothing here starts an agent, a terminal, a daemon or a real network connection
// beyond the coordinator's own loopback listeners.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createGitAdapter } from "@loom/adapter-git";
import type {
  ProviderSessionId,
  Repo,
  RepoId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "@loom/core";
import {
  FakeClock,
  FakeGitHub,
  FakePaneHost,
  FakeProviders,
  parseScenarios,
  type Scenario,
  type Step,
  substitute,
} from "@loom/fake-agent";
import { outputSchemas, resultSchema } from "@loom/mcp";
import { openStore, type Store } from "@loom/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Adapters } from "./adapters.js";
import {
  type CoordinatorConfig,
  configSchema,
  reconcileConfig,
} from "./config.js";
import { Coordinator } from "./coordinator.js";

const exec = promisify(execFile);

const GIT_ENVIRONMENT = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

export interface HarnessOptions {
  /** Serve the WebSocket protocol too. Off by default: most tests drive the loop directly. */
  serveProtocol?: boolean;
  /** Extra files committed into the repository before the branch exists. */
  files?: Record<string, string>;
  config?: Partial<Omit<CoordinatorConfig, "runModes">> & {
    /** Raw environment-style value parsed at the same boundary as production configuration. */
    runModes?: string;
  };
}

export interface Harness {
  coordinator: Coordinator;
  store: Store;
  clock: FakeClock;
  providers: FakeProviders;
  paneHost: FakePaneHost;
  github: FakeGitHub;
  adapters: Adapters;
  repo: Repo;
  config: CoordinatorConfig;
  dataRoot: string;
  repoRoot: string;
  git(...args: string[]): Promise<string>;
  /** Commits into a task's worktree, as an agent would. */
  commitIn(
    worktree: string,
    files: Record<string, string>,
    message: string,
    writeOnly?: boolean,
  ): Promise<Sha>;
  logs: string[];
  /** Every WORKFLOW `setup` the coordinator ran, in order; nothing is actually executed. */
  shellCalls: { command: string; cwd: string }[];
  close(): Promise<void>;
  /** Reopens the same data directory with fresh adapters, as a restart would. */
  restart(): Promise<Harness>;
}

export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "loom-coordinator-"));
  const repoRoot = join(root, "repo");
  const dataRoot = join(root, "data");
  await mkdir(repoRoot, { recursive: true });
  const git = async (...args: string[]) =>
    (
      await exec("git", args, {
        cwd: repoRoot,
        env: { ...process.env, ...GIT_ENVIRONMENT },
      })
    ).stdout.trim();
  await git("init", "-b", "main");
  await writeFile(join(repoRoot, "example.txt"), "base\n");
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const target = resolve(repoRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git("add", ".");
  await git("commit", "-m", "Base");
  // A real bare remote, so `push_branch` is a real push and `remoteHeadSha` is a real observation.
  const remote = join(root, "remote.git");
  await exec("git", ["init", "--bare", "-b", "main", remote], {
    env: { ...process.env, ...GIT_ENVIRONMENT },
  });
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");

  return open(root, repoRoot, dataRoot, git, options);
}

async function open(
  root: string,
  repoRoot: string,
  dataRoot: string,
  git: (...args: string[]) => Promise<string>,
  options: HarnessOptions,
): Promise<Harness> {
  const config = configSchema.parse({
    instance: "test",
    dataRoot,
    worktreeRoot: join(root, "worktrees"),
    baseBranch: "main",
    bind: "127.0.0.1:0",
    token: "test-token-0123456789abcdef",
    models: { codex: "fake-codex-model", claude: "fake-claude-model" },
    ...options.config,
  });
  const store = await openStore({
    dataRoot: config.dataRoot,
    instance: config.instance,
    config: reconcileConfig(config),
  });
  const clock = new FakeClock();
  const providers = new FakeProviders(clock, reconcileConfig(config).sha256);
  const paneHost = new FakePaneHost();
  const repo: Repo = {
    id: "example-repo" as RepoId,
    root: (await createGitAdapter().realpath(repoRoot)) as WorktreePath,
    github: "example/repo",
    baseBranch: "main",
    defaultProviders: {
      planner: "claude",
      implementer: "codex",
      reviewer: "claude",
    },
    serialTests: false,
  };
  store.putRepo(repo);
  // Core picks the branch name, and the fake is scoped to one branch, so the first call fixes it.
  const github = new FakeGitHub(clock, repo.github, "loom/pending", null);
  // A real GitHub survives a coordinator restart; this in-memory one does not, so on the first
  // call after a restart it reads the real remote back, which is what GitHub would already know.
  let seeded = false;
  const scope = async <T extends { branch: string }>(
    request: T,
  ): Promise<T> => {
    (github as unknown as { branch: string }).branch = request.branch;
    if (!seeded) {
      seeded = true;
      try {
        github.setHead(
          (
            await exec("git", ["rev-parse", `origin/${request.branch}`], {
              cwd: repoRoot,
              env: { ...process.env, ...GIT_ENVIRONMENT },
            })
          ).stdout.trim() as Sha,
        );
      } catch {
        // The branch has never been pushed; the fake has nothing to catch up on.
      }
    }
    return request;
  };
  const gitAdapter = createGitAdapter();
  // The fake GitHub owns the PR; the real remote owns the branch. A push tells the fake what the
  // remote now holds, which is what a real GitHub would have seen for itself.
  const git2: typeof gitAdapter = {
    ...gitAdapter,
    push: async (request) => {
      const result = await gitAdapter.push(request);
      seeded = true;
      github.setHead(result.remoteHeadSha);
      return result;
    },
  };
  const adapters: Adapters = {
    git: git2,
    github: {
      listPullRequests: github.listPullRequests,
      readPullRequestCommit: github.readPullRequestCommit,
      readPullRequestFile: github.readPullRequestFile,
      readPullRequestBehind: github.readPullRequestBehind,
      commentPullRequest: github.commentPullRequest,
      readPullRequest: github.readPullRequest,
      readPullRequestPatch: github.readPullRequestPatch,
      readCommitCi: github.readCommitCi,
      closePullRequest: github.closePullRequest,
      deleteBranch: github.deleteBranch,
      findPullRequest: async (request) =>
        github.findPullRequest(await scope(request)),
      openPullRequest: async (request) =>
        github.openPullRequest(await scope(request)),
      mergePullRequest: (request) => github.mergePullRequest(request),
      disableAutoMerge: (request) => github.disableAutoMerge(request),
    },
    paneHost,
    claude: providers.claude,
    codex: async () => providers.codex,
    codexIfRunning: () => providers.codex,
    stopCodexServer: async () => {}, // No-op in tests
    codexServerCount: () => 0, // Tests use fake provider, not real servers
    close: async () => {},
  };
  const logs: string[] = [];
  const shellCalls: { command: string; cwd: string }[] = [];
  const coordinator = new Coordinator({
    config,
    store,
    adapters,
    shell: async (command, cwd) => {
      shellCalls.push({ command, cwd });
    },
    now: () => clock.now(),
    after: (ms, callback) => clock.after(ms, callback),
    log: (message) => logs.push(message),
    serveProtocol: options.serveProtocol ?? false,
  });
  await coordinator.start();

  // An interactive Claude session is created by the process in the pane, which is exactly what the
  // pane host cannot report (spike 06 §4). The test stands in for that process: it creates the fake
  // session under the ID Loom recorded before launch, which is what a real `--session-id` does.
  const ensurePane = paneHost.ensurePane.bind(paneHost);
  paneHost.ensurePane = async (request) => {
    const ref = await ensurePane(request);
    if (request.runId === "lead" || request.runId.startsWith("lead-"))
      return ref;
    for (const task of store.tasks())
      for (const run of store.loadTaskState(task.id).runs)
        if (
          run.id === request.runId &&
          run.provider === "claude" &&
          run.sessionId
        )
          providers.create("claude", request.cwd, run.sessionId, "interactive");
    return ref;
  };

  // Interactive Claude sends reach the provider only because this test connects the pane write to
  // the session; the pane host itself records bytes and can neither name a session nor confirm one.
  const paste = paneHost.pasteText.bind(paneHost);
  paneHost.pasteText = async (ref, text) => {
    const written = await paste(ref, text);
    for (const task of store.tasks())
      for (const run of store.loadTaskState(task.id).runs)
        if (run.pane?.paneId === ref.paneId && run.sessionId)
          providers.enqueue(run.sessionId, text);
    return written;
  };

  const harness: Harness = {
    coordinator,
    store,
    clock,
    providers,
    paneHost,
    github,
    adapters,
    repo,
    config,
    dataRoot,
    repoRoot,
    git,
    logs,
    shellCalls,
    async commitIn(worktree, files, message, writeOnly = false) {
      for (const [path, content] of Object.entries(files)) {
        const target = resolve(worktree, path);
        if (!target.startsWith(`${worktree}/`) || target.includes("/.git/"))
          throw new Error("Unsafe fixture path");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const run = async (...args: string[]) =>
        (
          await exec("git", args, {
            cwd: worktree,
            env: { ...process.env, ...GIT_ENVIRONMENT },
          })
        ).stdout.trim();
      if (!writeOnly) {
        await run("add", "-A");
        await run("commit", "-m", message);
      }
      return (await run("rev-parse", "HEAD")) as Sha;
    },
    async close() {
      await coordinator.stop();
      await rm(root, { recursive: true, force: true });
    },
    async restart() {
      await coordinator.stop();
      return open(root, repoRoot, dataRoot, git, options);
    },
  };
  return harness;
}

// ---------------------------------------------------------------- scenario playback

interface Playback {
  scenario: Scenario;
  runId: RunId;
  taskId: TaskId;
  attempt: number;
  sessionId: ProviderSessionId;
  cursor: number;
  deadline?: number;
  requested?: boolean;
}

export interface DriverOptions {
  /** Stop as soon as this holds; the default runs until every bound script is consumed. */
  until?: () => boolean;
  maxSteps?: number;
  /** Allow bound scripts to finish with steps left over (a deliberately abandoned run). */
  allowIncomplete?: boolean;
}

/**
 * Plays `@loom/fake-agent` scenarios against a running coordinator. The workflow decisions, the
 * retries and the stage transitions are all the coordinator's; this only supplies provider events
 * and MCP calls, and advances the fake clock when nothing else can move.
 */
export class ScenarioDriver {
  private readonly scripts: Scenario[];
  private readonly used = new Set<Scenario>();
  private readonly playbacks: Playback[] = [];
  private readonly clients = new Map<string, Client>();
  readonly played: { scenario: string; index: number; step: Step }[] = [];

  constructor(
    private readonly harness: Harness,
    scenarios: readonly Scenario[],
  ) {
    this.scripts = parseScenarios(scenarios);
  }

  async run(options: DriverOptions = {}): Promise<void> {
    const limit = options.maxSteps ?? 400;
    try {
      for (let step = 0; step < limit; step++) {
        await this.harness.coordinator.settle();
        this.bind();
        if (options.until?.()) return this.finish(options);
        let progressed = false;
        for (const playback of this.playbacks)
          if (await this.step(playback)) {
            progressed = true;
            break;
          }
        if (progressed) continue;
        await this.harness.coordinator.settle();
        if (options.until?.()) return this.finish(options);
        if (this.complete()) return this.finish(options);
        const deadlines = this.playbacks.flatMap((p) =>
          p.deadline === undefined
            ? []
            : [Math.max(0, p.deadline - Date.parse(this.harness.clock.now()))],
        );
        const timer = this.harness.clock.nextDelay();
        if (timer !== null) deadlines.push(Math.max(0, timer));
        if (!deadlines.length)
          throw new Error(`Scenario deadlock: ${this.remaining()}`);
        this.harness.clock.advance(Math.min(...deadlines));
      }
      throw new Error(`Scenario step limit exceeded: ${this.remaining()}`);
    } finally {
      await Promise.all([...this.clients.values()].map((c) => c.close()));
      this.clients.clear();
    }
  }

  private finish(options: DriverOptions): void {
    if (options.allowIncomplete || options.until) return;
    if (!this.complete())
      throw new Error(`Scenario left over: ${this.remaining()}`);
  }

  private complete(): boolean {
    return (
      this.used.size === this.scripts.length &&
      this.playbacks.every((p) => p.cursor === p.scenario.steps.length)
    );
  }

  private remaining(): string {
    return this.scripts
      .filter((s) => !this.used.has(s))
      .map((s) => `${s.name} (not started)`)
      .concat(
        this.playbacks
          .filter((p) => p.cursor < p.scenario.steps.length)
          .map((p) => `${p.scenario.name} step ${p.cursor}`),
      )
      .join(", ");
  }

  /** Attaches a script to every newly launched run, exactly as the coordinator recorded it. */
  private bind(): void {
    for (const task of this.harness.store.tasks()) {
      const state = this.harness.store.loadTaskState(task.id);
      for (const run of state.runs) {
        if (
          run.endedAt ||
          !run.launchedAt ||
          !run.sessionId ||
          run.origin !== "loom" ||
          this.playbacks.some(
            (p) => p.runId === run.id && p.attempt === run.attempts,
          )
        )
          continue;
        const matches = this.scripts.filter(
          (s) =>
            !this.used.has(s) &&
            s.agent.provider === run.provider &&
            s.agent.role === run.role &&
            s.agent.mode === run.mode &&
            (s.agent.attempt === undefined || s.agent.attempt === run.attempts),
        );
        const scenario =
          matches.find((s) => s.agent.attempt === run.attempts) ?? matches[0];
        if (!scenario)
          throw new Error(
            `No scenario for ${run.provider}/${run.role}/${run.mode} attempt ${run.attempts}`,
          );
        this.used.add(scenario);
        this.playbacks.push({
          scenario,
          runId: run.id,
          taskId: task.id,
          attempt: run.attempts,
          sessionId: run.sessionId,
          cursor: 0,
        });
      }
    }
  }

  private async step(p: Playback): Promise<boolean> {
    const step = p.scenario.steps[p.cursor];
    if (!step) return false;
    const providers = this.harness.providers;
    const now = Date.parse(this.harness.clock.now());
    const session = providers.sessions.get(p.sessionId);
    if (!session) return false;
    if ("expect" in step && step.expect === "message") {
      p.deadline ??= now + (step.timeoutMs ?? 30000);
      const queued = session.queue[0];
      if (!queued) {
        if (now >= p.deadline)
          throw new Error(
            `Message timeout: ${p.scenario.name} step ${p.cursor}`,
          );
        return false;
      }
      if (step.match && !new RegExp(step.match).test(queued.text))
        throw new Error(
          `Message did not match ${step.match}: ${p.scenario.name} step ${p.cursor}`,
        );
      if (!providers.confirm(p.sessionId)) {
        if (now >= p.deadline)
          throw new Error(
            `Message timeout: ${p.scenario.name} step ${p.cursor}`,
          );
        return false;
      }
    } else if ("stall" in step) {
      p.deadline ??= now + step.stall;
      if (now < p.deadline) return false;
    } else if ("request" in step) {
      if (!p.requested) {
        providers.request(p.sessionId, step.request, step.summary);
        p.requested = true;
        return true;
      }
      if (session.answer === null) return false;
      if (session.answer !== step.expect)
        throw new Error(`Unexpected provider answer: ${p.scenario.name}`);
    } else {
      // A terminal MCP submission can end its own run, so the step is consumed before the call.
      p.cursor++;
      await this.perform(p, step);
      this.played.push({
        scenario: p.scenario.name,
        index: p.cursor - 1,
        step,
      });
      p.deadline = undefined;
      p.requested = false;
      return true;
    }
    this.played.push({ scenario: p.scenario.name, index: p.cursor, step });
    p.cursor++;
    p.deadline = undefined;
    p.requested = false;
    return true;
  }

  private async perform(p: Playback, step: Step): Promise<void> {
    const { providers, github, store } = this.harness;
    if ("tool" in step) {
      const state = store.loadTaskState(p.taskId);
      const head = state.worktree
        ? ((
            await this.harness.adapters.git.readWorktree(
              state.worktree.path,
              state.worktree.baseBranch,
            )
          ).headSha ?? null)
        : null;
      const input = substitute(step.input, {
        head,
        findings: state.findings.map((f) => f.id),
        questions: state.questions.map((q) => q.id),
      });
      const client = await this.client(p);
      const response = await client.callTool({
        name: step.tool,
        arguments: input as Record<string, unknown>,
      });
      const result = resultSchema(outputSchemas[step.tool]).parse(
        response.structuredContent,
      );
      if (
        step.expectError
          ? result.ok || result.error.code !== step.expectError
          : !result.ok
      )
        throw new Error(
          `Unexpected MCP result for ${step.tool}: ${JSON.stringify(result)}`,
        );
      return;
    }
    if ("status" in step) providers.status(p.sessionId, step.status);
    else if ("turn" in step)
      providers.finish(p.sessionId, step.turn, step.error);
    else if ("crash" in step) providers.crash(p.sessionId);
    else if ("dropDelivery" in step)
      providers.get(p.sessionId).dropDelivery = true;
    else if ("duplicate" in step) providers.hints.duplicate();
    else if ("rateLimit" in step)
      providers.rateLimit(p.sessionId, step.rateLimit.resetsInMs);
    else if ("git" in step || ("github" in step && step.github === "push")) {
      const worktree = store.loadTaskState(p.taskId).worktree;
      if (!worktree) throw new Error("The task has no worktree to commit into");
      const sha = await this.harness.commitIn(
        worktree.path,
        step.files,
        "message" in step ? step.message : "Human push",
        "git" in step && step.git === "write",
      );
      if ("github" in step) github.setHead(sha);
    } else if ("github" in step) {
      if (step.github === "ci") github.ci(step.conclusion);
      else if (step.github === "comment")
        github.comment(step.body, step.path, step.line, step.changesRequested);
      else if (step.github === "merge") github.merge();
      else if (step.github === "close") github.close();
    }
  }

  /** One MCP client per run, over the coordinator's real loopback HTTP endpoint and its token. */
  private async client(p: Playback): Promise<Client> {
    const existing = this.clients.get(p.runId);
    if (existing) return existing;
    const recipe = this.harness.coordinator.recipes.get(p.runId);
    const url = this.harness.coordinator.mcpUrl;
    if (!recipe || !url) throw new Error(`No MCP endpoint for ${p.runId}`);
    const client = new Client({ name: "loom-test-agent", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${recipe.token}` } },
      }),
    );
    this.clients.set(p.runId, client);
    return client;
  }
}
