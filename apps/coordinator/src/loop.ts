// The loop (brief §1, design §5.1). One pass per task at a time; enqueues during a pass coalesce
// into one more pass. A pass is: load state in one read transaction, read the owners outside it,
// reconcile, commit with compare-and-set. On a conflict, reload and retry up to three times, then
// re-enqueue and let a later pass do it.

import type {
  Input,
  Observations,
  ReconcileResult,
  TaskId,
  TaskState,
} from "@loom/core";
import { reconcile } from "@loom/core";
import type { CommitOutcome, Store } from "@loom/store";

/** Design §5.1 step 5: three attempts, then the task goes back on the queue. */
export const COMMIT_ATTEMPTS = 3;

export interface PassOutcome {
  taskId: TaskId;
  result: ReconcileResult | null;
  /** The version the commit produced, or null when every attempt lost the race. */
  version: number | null;
  conflicts: number;
}

export interface LoopDeps {
  store: Store;
  /** Runs every claimable outbox row and answers how many ran. Supplied lazily: the executor
   * enqueues passes, and the loop drains the executor, so neither can be built before the other. */
  drainExecutor(): Promise<number>;
  observe(state: TaskState, inputs: Input[]): Promise<Observations>;
  /** Called inside the loop after a successful commit, before the next pass. */
  onCommit(outcome: {
    taskId: TaskId;
    result: ReconcileResult;
    version: number;
  }): void;
  onError(error: Error, taskId: TaskId): void;
  /** The store's default is one input per pass; the loop does not raise it (design §8). */
  inputLimit?: number;
  /** Guards a runaway settle: a pass that always enqueues another would never finish. */
  maxCycles?: number;
}

export class Loop {
  private readonly pending = new Set<TaskId>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private settling: Promise<void> | null = null;
  constructor(private readonly deps: LoopDeps) {}

  /** A hint, a new input, a timer or the resync: all of them only ask for a pass. */
  enqueue(taskId: TaskId): void {
    this.pending.add(taskId);
  }

  get queued(): number {
    return this.pending.size;
  }

  /** Runs one pass for a task, serialized against every other pass for that task. */
  pass(taskId: TaskId): Promise<PassOutcome> {
    return this.serial(taskId, () => this.onePass(taskId));
  }

  /**
   * Runs queued passes and the executor until neither has anything left. Every action result is
   * an input, so this converges: the caller gets a quiet coordinator or an error.
   */
  settle(): Promise<void> {
    if (this.settling) return this.settling;
    const work = this.drain().finally(() => {
      this.settling = null;
    });
    this.settling = work;
    return work;
  }

  private async drain(): Promise<void> {
    const limit = this.deps.maxCycles ?? 2000;
    for (let cycle = 0; cycle < limit; cycle++) {
      if (this.pending.size) {
        const tasks = [...this.pending];
        this.pending.clear();
        for (const taskId of tasks) {
          try {
            await this.pass(taskId);
          } catch (error) {
            this.deps.onError(
              error instanceof Error ? error : new Error(String(error)),
              taskId,
            );
          }
        }
        continue;
      }
      if (await this.deps.drainExecutor()) continue;
      return;
    }
    throw new Error("The reconcile loop did not settle");
  }

  private async onePass(taskId: TaskId): Promise<PassOutcome> {
    const { store } = this.deps;
    let conflicts = 0;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      const state = store.loadTaskState(taskId);
      const inputs = store.pendingInputs(taskId, this.deps.inputLimit ?? 1);
      const observations = await this.deps.observe(state, inputs);
      const result = reconcile(state, observations);
      const outcome: CommitOutcome = store.commit(
        taskId,
        result,
        state.task.version,
      );
      if (!outcome.ok) {
        conflicts++;
        continue;
      }
      // More inputs than this pass consumed, or actions to run: come back round.
      if (
        store.pendingInputs(taskId, 1).length ||
        result.actions.length ||
        observations.inputs.length > result.inputs.length
      )
        this.enqueue(taskId);
      this.deps.onCommit({ taskId, result, version: outcome.version });
      return { taskId, result, version: outcome.version, conflicts };
    }
    this.enqueue(taskId);
    return { taskId, result: null, version: null, conflicts };
  }

  /** One chain per task: a second caller waits rather than running a concurrent pass. */
  private serial<T>(taskId: TaskId, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const result = previous.then(work, work);
    this.chains.set(
      taskId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
