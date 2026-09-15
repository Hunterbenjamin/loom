// The loop (brief §1, design §5.1). One pass per task at a time, and passes for different tasks run
// concurrently; enqueues during a pass coalesce into one more pass. A pass is: load state in one read
// transaction, read the owners outside it, reconcile, commit with compare-and-set. On a conflict,
// reload and retry up to three times, then re-enqueue and let a later pass do it.
//
// Human commands don't wait for a pass (design §5.1a): `applyHuman` decides them synchronously
// against the readings the task's last pass committed with, which is what the human was looking at.
// Until a fresh pass confirms that commit, the task is unverified and the executor runs none of its
// actions, so every side effect still follows a fresh reading.

import type {
  Input,
  Observations,
  ReconcileResult,
  TaskId,
  TaskState,
} from "@loom/core";
import { decidableFromLastReadings, reconcile } from "@loom/core";
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
  /**
   * The last committed readings with this moment's local facts (clock, capacity) and the given
   * inputs. Synchronous: it may not read an external owner.
   */
  rebase(readings: Observations, inputs: Input[]): Observations;
  /** Called after a successful commit, before the next pass for that task. */
  onCommit(outcome: {
    taskId: TaskId;
    result: ReconcileResult;
    version: number;
  }): void;
  onError(error: Error, taskId: TaskId): void;
  /** The store's default is one input per pass; the loop does not raise it (design §8). */
  inputLimit?: number;
  /** Passes that may read owners at the same time. */
  concurrency?: number;
  /** Guards a runaway settle: a pass that always enqueues another would never finish. */
  maxCycles?: number;
}

export class Loop {
  private readonly pending = new Set<TaskId>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<TaskId, Promise<unknown>>();
  /** Each task's observations from its last committed pass in this process. */
  private readonly readings = new Map<TaskId, Observations>();
  /** Tasks whose latest commit came from a fresh pass in this process. */
  private readonly verified = new Set<TaskId>();
  private settling: Promise<void> | null = null;
  private running = false;
  constructor(private readonly deps: LoopDeps) {}

  /** A hint, a new input, a timer or the resync: all of them only ask for a pass. */
  enqueue(taskId: TaskId): void {
    this.pending.add(taskId);
    if (this.running) queueMicrotask(() => this.kick());
  }

  get queued(): number {
    return this.pending.size;
  }

  /** From now on an enqueue starts its pass straight away, instead of waiting for `settle`. */
  start(): void {
    this.running = true;
    this.kick();
  }

  stop(): void {
    this.running = false;
  }

  /** Whether the executor may act for this task: its latest commit rests on fresh readings. */
  isVerified(taskId: TaskId): boolean {
    return this.verified.has(taskId);
  }

  /** Runs one pass for a task, serialized against every other pass for that task. */
  pass(taskId: TaskId): Promise<PassOutcome> {
    return this.serial(taskId, () => this.onePass(taskId));
  }

  /**
   * Accepts the task's leading human inputs now, without reading an owner. Answers the outcome of
   * the last commit, or null when there is nothing to decide this way: no readings from an earlier
   * pass yet, an input first in line that core doesn't decide from last readings, or a refusal,
   * which only a fresh reading may give. Either way a pass follows.
   */
  applyHuman(taskId: TaskId): PassOutcome | null {
    const { store } = this.deps;
    const readings = this.readings.get(taskId);
    let outcome: PassOutcome | null = null;
    if (readings)
      for (let conflicts = 0; conflicts < COMMIT_ATTEMPTS; ) {
        const inputs = store.pendingInputs(taskId, 1);
        const input = inputs[0];
        if (
          input?.type !== "human" ||
          !decidableFromLastReadings(input.command)
        )
          break;
        const state = store.loadTaskState(taskId);
        const result = reconcile(state, this.deps.rebase(readings, inputs));
        // A receipt reconcile already holds is the store's to settle, and a refusal on old readings
        // may be wrong: a pass with fresh readings decides both.
        if (!result.inputs[0]?.accepted) break;
        const committed = store.commit(taskId, result, state.task.version);
        if (!committed.ok) {
          conflicts++;
          continue;
        }
        this.verified.delete(taskId);
        this.deps.onCommit({ taskId, result, version: committed.version });
        outcome = { taskId, result, version: committed.version, conflicts };
      }
    this.enqueue(taskId);
    return outcome;
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
      this.kick();
      await Promise.all(this.inflight.values());
      // Busy providers may enqueue throughout every observation pass. Give already-committed
      // actions a turn after each batch instead of waiting for the hint queue to go quiet.
      const executed = await this.deps.drainExecutor();
      if (executed || this.pending.size || this.inflight.size) continue;
      return;
    }
    throw new Error("The reconcile loop did not settle");
  }

  /** Starts a pass for every queued task that has none running, up to the concurrency limit. */
  private kick(): void {
    const limit = this.deps.concurrency ?? 8;
    for (const taskId of [...this.pending]) {
      if (this.inflight.size >= limit) return;
      if (this.inflight.has(taskId)) continue;
      this.pending.delete(taskId);
      const work = this.pass(taskId)
        .catch((error) =>
          this.deps.onError(
            error instanceof Error ? error : new Error(String(error)),
            taskId,
          ),
        )
        .finally(() => {
          this.inflight.delete(taskId);
          if (!this.running) return;
          void this.deps.drainExecutor();
          this.kick();
        });
      this.inflight.set(taskId, work);
    }
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
      this.readings.set(taskId, observations);
      this.verified.add(taskId);
      // A launch result binds the provider identity after observations were read. Refresh it
      // immediately so headless Codex runs can receive their first turn without a later hint.
      const launched = result.next.runs.some(
        (run) =>
          run.launchedAt &&
          state.runs.find((old) => old.id === run.id)?.launchedAt !==
            run.launchedAt,
      );
      // More inputs than this pass consumed, actions to run, or a new launch: come back round.
      if (
        launched ||
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
