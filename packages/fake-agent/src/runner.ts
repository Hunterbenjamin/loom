import type {
  Action,
  ActionResult,
  GetTaskContextOutput,
  GitWorktreeObservation,
  Input,
  InputDisposition,
  InputId,
  Observations,
  ProviderSessionId,
  ReconcileResult,
  Run,
  TaskState,
  Transition,
} from "@loom/core";
import { reconcile } from "@loom/core";
import {
  createMcpServer,
  McpGuardError,
  type McpServerOptions,
  outputSchemas,
  resultSchema,
} from "@loom/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FakeClock } from "./clock.js";
import { FakeGitHub, FakePaneHost } from "./owners.js";
import { FakeProviders } from "./providers.js";
import {
  parseScenarios,
  type Scenario,
  type Step,
  substitute,
} from "./scenario.js";

export function createFakeAdapters(
  clock: FakeClock,
  state: TaskState,
  pr: ConstructorParameters<typeof FakeGitHub>[3] = null,
) {
  const providers = new FakeProviders(clock, state.config.sha256);
  return {
    providers,
    codex: providers.codex,
    claude: providers.claude,
    paneHost: new FakePaneHost(),
    github: new FakeGitHub(
      clock,
      state.task.repoId,
      state.task.branch ?? "fake",
      pr,
    ),
  };
}
export type FakeAdapters = ReturnType<typeof createFakeAdapters>;
export interface ScenarioOptions {
  scenarios: readonly Scenario[];
  state: TaskState;
  adapters: FakeAdapters;
  clock: FakeClock;
  /** Fresh reads, supplied by the test or future coordinator. */
  observe(runner: ScenarioRunner): Observations | Promise<Observations>;
  /** No executor lives here. The test/coordinator performs effects and returns native results. */
  onAction?(
    action: Action,
    runner: ScenarioRunner,
  ): Promise<ActionResult | undefined>;
  commit?(
    step: { files: Record<string, string>; message: string; human: boolean },
    runner: ScenarioRunner,
  ): Promise<void>;
  /** Supply a store-backed host/anchor reader when testing the future coordinator. */
  mcp?(runner: ScenarioRunner, defaults: McpServerOptions): McpServerOptions;
  /** Called after each committed reconcile, useful for explicit human interventions. */
  afterPass?(runner: ScenarioRunner, result: ReconcileResult): void;
  maxSteps?: number;
}
interface Playback {
  scenario: Scenario;
  runId: Run["id"];
  attempt: number;
  sessionId: ProviderSessionId;
  token: string;
  cursor: number;
  deadline?: number;
  requested?: boolean;
}
export interface ScenarioResult {
  state: TaskState;
  transitions: Transition[];
  actions: Action[];
  dispositions: InputDisposition[];
  steps: { scenario: string; index: number; step: Step }[];
}
/** Bounded test driver. All workflow decisions, retries and timeout actions come from core. */
export class ScenarioRunner {
  state: TaskState;
  readonly transitions: Transition[] = [];
  readonly actions: Action[] = [];
  readonly dispositions: InputDisposition[] = [];
  readonly steps: ScenarioResult["steps"] = [];
  private scripts: Scenario[];
  private used = new Set<Scenario>();
  private playbacks: Playback[] = [];
  private connections = new Map<
    string,
    { client: Client; close(): Promise<void> }
  >();
  private receipts = new Map<InputId, InputDisposition>();
  private inputSequence = 0;
  private pendingInputs: Input[] = [];
  private scheduled = new Set<string>();
  private cancels: (() => void)[] = [];
  private observations: Observations | null = null;
  constructor(readonly options: ScenarioOptions) {
    this.state = {
      ...structuredClone({ ...options.state, config: undefined }),
      config: options.state.config,
    };
    this.scripts = parseScenarios(options.scenarios);
    if (
      options.adapters.providers.clock !== options.clock ||
      options.adapters.github.clock !== options.clock
    )
      throw new Error("Adapters and runner must share the fake clock");
  }
  get clock() {
    return this.options.clock;
  }
  get adapters() {
    return this.options.adapters;
  }
  input(command: Extract<Input, { type: "human" }>["command"]) {
    this.pendingInputs.push({
      id: `fake-human-${++this.inputSequence}` as InputId,
      receivedAt: this.clock.now(),
      type: "human",
      command,
    });
  }
  async pass(inputs: Input[] = []): Promise<ReconcileResult> {
    this.observations = await this.options.observe(this);
    this.observations.now = this.clock.now();
    this.observations.runs = await Promise.all(
      this.state.runs
        .filter((r) => !r.endedAt)
        .map(async (r) => ({
          ...this.adapters.providers.observe(r),
          pane: r.pane
            ? {
                ok: true as const,
                at: this.clock.now(),
                value: await this.adapters.paneHost.getPane(r.pane),
              }
            : null,
        })),
    );
    const result = reconcile(this.state, {
      ...this.observations,
      inputs: [...this.pendingInputs.splice(0), ...inputs],
    });
    this.state = result.next;
    this.transitions.push(...result.transitions);
    this.actions.push(...result.actions);
    this.dispositions.push(...result.inputs);
    for (const disposition of result.inputs)
      this.receipts.set(disposition.inputId, disposition);
    this.options.afterPass?.(this, result);
    return result;
  }
  async run(): Promise<ScenarioResult> {
    try {
      await this.pass();
      for (let tick = 0; tick < (this.options.maxSteps ?? 10000); tick++) {
        this.bindRuns();
        if (this.pendingInputs.length) {
          await this.pass();
          continue;
        }
        const pending = this.state.outbox.find(
          (row) =>
            row.status === "pending" &&
            row.action &&
            (row.dependsOn ?? []).every((key) =>
              this.state.outbox.some(
                (r) => r.key === key && r.status === "succeeded",
              ),
            ),
        );
        if (pending?.action && this.options.onAction) {
          const action = pending.action;
          const result = await this.options.onAction(action, this);
          if (result) {
            if (result.kind !== action.kind)
              throw new Error("Action result kind mismatch");
            if (
              action.kind === "schedule" &&
              result.ok &&
              !this.scheduled.has(action.key)
            ) {
              this.scheduled.add(action.key);
              this.cancels.push(
                this.clock.after(
                  Math.max(
                    0,
                    Date.parse(action.at) - Date.parse(this.clock.now()),
                  ),
                  () => {},
                ),
              );
            }
            await this.pass([
              {
                id: `fake-result-${++this.inputSequence}` as InputId,
                receivedAt: this.clock.now(),
                type: "action_result",
                key: action.key,
                result,
              },
            ]);
            // Re-read using the session identity just committed by the action result.
            await this.pass();
            continue;
          }
        }
        let progressed = false;
        for (const playback of this.playbacks) {
          if (await this.step(playback)) {
            progressed = true;
            break;
          }
        }
        if (progressed) {
          await this.pass();
          continue;
        }
        if (this.pendingInputs.length) {
          await this.pass();
          continue;
        }
        if (
          this.used.size === this.scripts.length &&
          this.playbacks.every((p) => p.cursor === p.scenario.steps.length)
        )
          return {
            state: this.state,
            transitions: this.transitions,
            actions: this.actions,
            dispositions: this.dispositions,
            steps: this.steps,
          };
        const deadlines = this.playbacks.flatMap((p) =>
          p.deadline === undefined
            ? []
            : [Math.max(0, p.deadline - Date.parse(this.clock.now()))],
        );
        const timer = this.clock.nextDelay();
        if (timer !== null) deadlines.push(timer);
        if (!deadlines.length)
          throw new Error(`Scenario deadlock: ${this.remaining()}`);
        this.clock.advance(Math.min(...deadlines));
        await this.pass();
      }
      throw new Error(`Scenario step limit exceeded: ${this.remaining()}`);
    } finally {
      for (const cancel of this.cancels) cancel();
      await Promise.all([...this.connections.values()].map((c) => c.close()));
    }
  }
  private remaining() {
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
  private bindRuns() {
    for (const p of this.playbacks) {
      const run = this.state.runs.find((r) => r.id === p.runId);
      if (
        (!run || run.endedAt || run.attempts !== p.attempt) &&
        p.cursor < p.scenario.steps.length
      )
        throw new Error(
          `Run ended with leftover steps: ${p.scenario.name} step ${p.cursor}`,
        );
    }
    for (const run of this.state.runs) {
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
      this.adapters.providers.get(run.sessionId); // The caller records/launches before playback starts.
      this.playbacks.push({
        scenario,
        runId: run.id,
        attempt: run.attempts,
        sessionId: run.sessionId,
        token: `fake-token-${this.playbacks.length}`,
        cursor: 0,
      });
    }
  }
  private async step(p: Playback): Promise<boolean> {
    const step = p.scenario.steps[p.cursor];
    if (!step) return false;
    const now = Date.parse(this.clock.now());
    const session = this.adapters.providers.get(p.sessionId);
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
      if (!this.adapters.providers.confirm(p.sessionId)) {
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
        this.adapters.providers.request(
          p.sessionId,
          step.request,
          step.summary,
        );
        p.requested = true;
        return true;
      }
      if (session.answer === null) return false;
      if (session.answer !== step.expect)
        throw new Error(`Unexpected provider answer: ${p.scenario.name}`);
    } else {
      // A terminal MCP submission may end its own run. Consume this step before calling core.
      p.cursor++;
      await this.perform(p, step);
      this.steps.push({ scenario: p.scenario.name, index: p.cursor - 1, step });
      p.deadline = undefined;
      p.requested = false;
      return true;
    }
    this.steps.push({ scenario: p.scenario.name, index: p.cursor, step });
    p.cursor++;
    p.deadline = undefined;
    p.requested = false;
    return true;
  }
  private async perform(p: Playback, step: Step) {
    const providers = this.adapters.providers;
    if ("tool" in step) {
      const git = this.observations?.git;
      const input = substitute(step.input, {
        head: git?.ok ? git.value.headSha : null,
        findings: this.state.findings.map((f) => f.id),
        questions: this.state.questions.map((q) => q.id),
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
    } else if ("status" in step) providers.status(p.sessionId, step.status);
    else if ("turn" in step)
      providers.finish(p.sessionId, step.turn, step.error);
    else if ("crash" in step) providers.crash(p.sessionId);
    else if ("dropDelivery" in step)
      providers.get(p.sessionId).dropDelivery = true;
    else if ("duplicate" in step) providers.hints.duplicate();
    else if ("rateLimit" in step)
      providers.rateLimit(p.sessionId, step.rateLimit.resetsInMs);
    else if ("git" in step || ("github" in step && step.github === "push")) {
      if (!this.options.commit)
        throw new Error("Git scenario steps require a commit callback");
      await this.options.commit(
        {
          files: step.files,
          message: "message" in step ? step.message : "Human push",
          human: "github" in step,
        },
        this,
      );
    } else if ("github" in step) {
      if (step.github === "ci") this.adapters.github.ci(step.conclusion);
      else if (step.github === "comment")
        this.adapters.github.comment(
          step.body,
          step.path,
          step.line,
          step.changesRequested,
        );
      else if (step.github === "merge") this.adapters.github.merge();
      else if (step.github === "close") this.adapters.github.close();
    }
  }
  private async client(p: Playback): Promise<Client> {
    const previous = this.connections.get(p.token);
    if (previous) return previous.client;
    const defaults: McpServerOptions = {
      resolveToken: (token) => {
        const playback = this.playbacks.find((s) => s.token === token);
        if (!playback) return null;
        const run = this.state.runs.find((r) => r.id === playback.runId);
        const current =
          run &&
          this.state.runs
            .filter((r) => r.origin === "loom" && r.role === run.role)
            .at(-1);
        return {
          runId: playback.runId,
          active:
            !!run &&
            !run.endedAt &&
            run.attempts === playback.attempt &&
            current?.id === run.id &&
            !["done", "canceled"].includes(this.state.task.stage),
        };
      },
      host: {
        context: (id) => this.context(id),
        submit: async (input) => {
          const previous = this.receipts.get(input.id);
          if (previous) return structuredClone(previous);
          const result = await this.pass([
            { ...input, receivedAt: this.clock.now() },
          ]);
          const disposition = result.inputs.find((d) => d.inputId === input.id);
          if (!disposition) throw new Error("Missing MCP disposition");
          return disposition;
        },
      },
      buildAnchor: async () => {
        throw new McpGuardError([
          "Supply an anchor reader for file-level findings",
        ]);
      },
    };
    const server = createMcpServer(
      this.options.mcp?.(this, defaults) ?? defaults,
      p.token,
    );
    const client = new Client({ name: "loom-fake-agent", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const close = async () => {
      await client.close();
      await server.close();
    };
    this.connections.set(p.token, { client, close });
    await server.connect(a);
    await client.connect(b);
    return client;
  }
  private context(id: Run["id"]): GetTaskContextOutput {
    const run = this.state.runs.find((r) => r.id === id);
    const worktree = this.state.worktree;
    if (!run || !worktree) throw new Error("Missing task context");
    const git = this.observations?.git;
    return {
      task: {
        id: this.state.task.id,
        title: this.state.task.title,
        description: this.state.task.description,
        stage: this.state.task.stage,
        reviewRound: this.state.task.reviewRound,
        reviewRoundCap: this.state.task.reviewRoundCap,
      },
      role: run.role,
      run: { id, round: run.round, attempts: run.attempts },
      worktree: {
        path: worktree.path,
        branch: worktree.branch,
        baseBranch: worktree.baseBranch,
        baseSha: worktree.baseSha,
        headSha: git?.ok ? git.value.headSha : null,
      },
      brief: this.state.task.description,
      plan: this.state.plan
        ? (({ accepted: _accepted, ...plan }) => plan)(this.state.plan)
        : null,
      decisions: String(this.state.artifactContents.decisions ?? ""),
      handoff: (this.state.artifactContents.handoff ??
        null) as GetTaskContextOutput["handoff"],
      findings: this.state.findings
        .filter((f) =>
          run.role === "reviewer"
            ? f.round < run.round
            : ["open", "addressed", "disputed"].includes(f.status),
        )
        .map((f) => ({
          id: f.id,
          round: f.round,
          source: f.source,
          severity: f.severity,
          blocking: f.blocking,
          status: f.status,
          title: f.title,
          body: f.body,
          location: f.location
            ? {
                path: f.location.path,
                side: f.location.side,
                startLine: f.location.startLine,
                endLine: f.location.endLine,
                mapping: f.location.status,
              }
            : null,
          snippet: f.anchor?.selectedText ?? null,
        })),
      testResults: (this.state.artifactContents.test_results ??
        []) as GetTaskContextOutput["testResults"],
      answeredQuestions: this.state.questions.flatMap((q) =>
        q.answer ? [{ id: q.id, question: q.question, answer: q.answer }] : [],
      ),
      workflow: {},
    };
  }
}
export const runScenario = (
  options: ScenarioOptions,
): Promise<ScenarioResult> => new ScenarioRunner(options).run();

/** Compose the native owner snapshots with caller-supplied git/capacity/dependency reads. */
export function observeFakes(
  runner: ScenarioRunner,
  git: GitWorktreeObservation,
  extra: Partial<
    Pick<Observations, "capacity" | "dependencies" | "externalSessions">
  > = {},
): Observations {
  const now = runner.clock.now();
  return {
    now,
    git: { ok: true, at: now, value: git },
    github: { ok: true, at: now, value: runner.adapters.github.snapshot() },
    runs: [],
    inputs: [],
    externalSessions: [],
    dependencies: [],
    capacity: {
      version: runner.state.task.version,
      active: { codex: 0, claude: 0 },
      caps: { total: 4, codex: 4, claude: 4 },
      coolingDownUntil: { codex: null, claude: null },
    },
    ...extra,
  };
}
