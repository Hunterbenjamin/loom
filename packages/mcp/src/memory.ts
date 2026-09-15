import {
  type GetTaskContextFullOutput,
  type GetTaskContextInput,
  type GetTaskContextOutput,
  type InputDisposition,
  type InputId,
  type Observations,
  type RunId,
  reconcile,
  type TaskState,
  taskContextChanges,
} from "@loom/core";
import type { McpHost, McpInput } from "./server.js";

/** Test host only: inbox + dispositions in memory; invokes core but never executes its actions. */
export class InMemoryHost implements McpHost {
  readonly inputs: McpInput[] = [];
  readonly dispositions = new Map<InputId, InputDisposition>();
  readonly tokens = new Map<string, RunId>();
  passes = 0;
  private readonly contextReads = new Map<
    RunId,
    { sessionEpoch: number; context: GetTaskContextFullOutput }
  >();
  constructor(
    public state: TaskState,
    public observations: Observations,
    private readonly readContext: (
      state: TaskState,
      runId: RunId,
    ) => GetTaskContextFullOutput,
  ) {}
  resolveToken = (token: string) => {
    const runId = this.tokens.get(token);
    if (!runId) return null;
    const run = this.state.runs.find((r) => r.id === runId);
    const current =
      run &&
      this.state.runs
        .filter((r) => r.origin === "loom" && r.role === run.role)
        .at(-1);
    return {
      runId,
      active:
        !!run &&
        run.origin === "loom" &&
        !run.endedAt &&
        current?.id === runId &&
        this.state.task.stage !== "done" &&
        this.state.task.stage !== "canceled",
    };
  };
  context(runId: RunId, input: GetTaskContextInput = {}): GetTaskContextOutput {
    const run = this.state.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("Missing context run");
    const current = structuredClone(this.readContext(this.state, runId));
    const previous = this.contextReads.get(runId);
    this.contextReads.set(runId, {
      sessionEpoch: run.sessionEpoch,
      context: current,
    });
    return input.full || !previous || previous.sessionEpoch !== run.sessionEpoch
      ? current
      : taskContextChanges(previous.context, current);
  }
  async submit(input: McpInput): Promise<InputDisposition> {
    const previous = this.dispositions.get(input.id);
    if (previous) return structuredClone(previous);
    // No await between persistence, reconcile and commit: concurrent calls are serialized.
    this.inputs.push(structuredClone(input));
    const result = reconcile(this.state, {
      ...this.observations,
      inputs: [input],
    });
    const disposition = result.inputs.find((d) => d.inputId === input.id);
    if (!disposition)
      throw new Error("Reconcile did not return the submitted input");
    this.state = result.next;
    this.passes++;
    this.dispositions.set(input.id, structuredClone(disposition));
    return structuredClone(disposition);
  }
}
