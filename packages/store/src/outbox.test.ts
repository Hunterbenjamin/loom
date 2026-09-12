import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionKey, Input, InputId, IsoTime } from "@loom/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  config,
  notify,
  now,
  repo,
  required,
  result,
  task,
  taskId,
} from "../test/fixtures.js";
import { openStore, type Store } from "./index.js";

let root: string, store: Store;
const stores: Store[] = [];
async function open() {
  const s = await openStore({ dataRoot: root, instance: "dev", config, now });
  stores.push(s);
  return s;
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "loom-outbox-"));
  store = await open();
  store.putRepo(repo);
  store.createTask(task());
});
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});
function addActions() {
  const next = store.loadTaskState(taskId);
  next.task.version++;
  const first = notify(next, "first"),
    second = notify(next, "second", [first.key]);
  store.commit(
    taskId,
    { ...result(next), actions: [first, second] },
    next.task.version - 1,
  );
  return [first, second] as const;
}
function receipt(
  key: ActionKey,
  id = "action-result",
): Extract<Input, { type: "action_result" }> {
  return {
    id: id as InputId,
    key,
    receivedAt: now,
    type: "action_result",
    result: { kind: "notify", ok: true, output: {} },
  };
}
it("outbox key insertion is idempotent and retains the original intent", () => {
  const [first, second] = addActions();
  const next = store.loadTaskState(taskId);
  next.task.version++;
  expect(
    store.commit(
      taskId,
      { ...result(next), actions: [first, second, first] },
      next.task.version - 1,
    ).ok,
  ).toBe(true);
  expect(store.outbox.list(taskId)).toHaveLength(2);
});
it("claims once across connections, invalidating in-flight reconcile snapshots", async () => {
  addActions();
  const second = await open();
  const stale = store.loadTaskState(taskId);
  stale.task.version++;
  const claimed = required(store.outbox.claim(now));
  expect(second.outbox.claim(now)).toBeNull();
  expect(
    store.commit(taskId, result(stale), stale.task.version - 1),
  ).toMatchObject({ conflict: "task_version" });
  expect(store.outbox.isClaimCurrent(claimed.key, claimed.claimVersion)).toBe(
    true,
  );
});
it("waits for dependency success through core, not merely an executor receipt", () => {
  const [first, second] = addActions();
  const claimed = required(store.outbox.claim(now));
  expect(claimed.key).toBe(first.key);
  expect(
    store.outbox.finish(first.key, claimed.claimVersion, receipt(first.key)),
  ).toBe(true);
  expect(
    store.outbox.finish(
      first.key,
      claimed.claimVersion,
      receipt(first.key, "duplicate-result"),
    ),
  ).toBe(false);
  expect(store.pendingInputs(taskId)).toHaveLength(1);
  expect(store.outbox.claim(now)).toBeNull();
  const next = store.loadTaskState(taskId);
  next.task.version++;
  const entry = required(next.outbox[0]);
  entry.status = "succeeded";
  entry.finishedAt = now;
  next.consumedInputIds = [receipt(first.key).id];
  store.commit(
    taskId,
    {
      ...result(next),
      inputs: [{ inputId: receipt(first.key).id, accepted: true, reply: null }],
    },
    next.task.version - 1,
  );
  expect(store.outbox.claim(now)?.key).toBe(second.key);
});
it("reports interrupted rows on restart and preserves completed executor receipts", async () => {
  const [first] = addActions();
  const claimed = required(store.outbox.claim(now));
  store.close();
  const recovered = await open();
  expect(recovered.startupRunning).toEqual([
    { taskId, entry: claimed, startedAt: now },
  ]);
  expect(recovered.outbox.claim(now)).toBeNull();
  expect(
    recovered.outbox.finish(
      first.key,
      claimed.claimVersion,
      receipt(first.key),
    ),
  ).toBe(true);
  recovered.close();
  const restarted = await open();
  expect(restarted.startupRunning).toEqual([]);
  expect(restarted.pendingInputs(taskId)).toEqual([receipt(first.key)]);
});
it("honors retryAt, retry dependencies, and canceled intents", () => {
  const [first] = addActions();
  const next = store.loadTaskState(taskId);
  next.task.version++;
  required(next.outbox[0]).status = "failed";
  required(next.outbox[0]).finishedAt = now;
  const retry = notify(next, "first#2");
  const retryRow = required(next.outbox[2]);
  retryRow.retryAt = "2026-09-12T00:01:00.000Z" as IsoTime;
  retryRow.retryBaseAttempt = 1;
  required(next.outbox[0]).retriedBy = retry.key;
  required(next.outbox[1]).dependsOn = [retry.key];
  store.commit(
    taskId,
    { ...result(next), actions: [retry] },
    next.task.version - 1,
  );
  expect(store.outbox.claim(now)).toBeNull();
  const claimed = required(store.outbox.claim(retryRow.retryAt));
  expect(claimed.key).toBe(retry.key);
  const canceled = store.loadTaskState(taskId);
  canceled.task.version++;
  required(canceled.outbox.find((row) => row.key === retry.key)).status =
    "canceled";
  store.commit(taskId, result(canceled), canceled.task.version - 1);
  expect(store.outbox.isClaimCurrent(retry.key, claimed.claimVersion)).toBe(
    false,
  );
  expect(
    store.outbox.finish(retry.key, claimed.claimVersion, receipt(retry.key)),
  ).toBe(false);
  expect(store.outbox.claim(retryRow.retryAt)).toBeNull();
  expect(
    store.outbox.list(taskId).find((r) => r.key === first.key)?.retriedBy,
  ).toBe(retry.key);
});
it("requeues only explicitly and rejects late receipts from the previous claim", () => {
  addActions();
  const first = required(store.outbox.claim(now));
  expect(store.outbox.requeue(first.key, first.claimVersion)).toBe(true);
  const second = required(store.outbox.claim(now));
  expect(second.claimVersion).toBe(first.claimVersion + 1);
  expect(
    store.outbox.finish(first.key, first.claimVersion, receipt(first.key)),
  ).toBe(false);
  expect(
    store.outbox.finish(second.key, second.claimVersion, receipt(second.key)),
  ).toBe(true);
});

it("does not increment core-assigned retry attempts when claiming", () => {
  const next = store.loadTaskState(taskId);
  next.task.version++;
  const action = notify(next, "retry#2");
  const row = next.outbox[0];
  if (!row) throw new Error("Missing fixture intent");
  row.attempts = 2;
  row.retryBaseAttempt = 0;
  row.retryAt = undefined;
  store.commit(taskId, { ...result(next), actions: [action] }, 0);
  expect(store.outbox.claim(now)).toMatchObject({
    attempts: 2,
    claimVersion: 1,
  });
});

it("reads the last ten task outbox rows with executor receipts before and after consumption", () => {
  const next = store.loadTaskState(taskId);
  next.task.version++;
  for (let i = 0; i < 12; i++) notify(next, `row-${i}`);
  store.commit(taskId, result(next), 0);
  for (let i = 0; i < 3; i++) {
    const claimed = required(store.outbox.claim(now));
    store.outbox.finish(
      claimed.key,
      claimed.claimVersion,
      receipt(claimed.key, `receipt-${i}`),
    );
  }
  const rows = store.outbox.recent(taskId);
  expect(rows.map((r) => r.key)).toEqual(
    Array.from({ length: 10 }, (_, i) => `row-${i + 2}`),
  );
  expect(rows[0]).toEqual({
    key: "row-2",
    status: "running",
    started_at: now,
    executor_finished_at: now,
    result: { kind: "notify", ok: true, output: {} },
  });
  expect(rows[1]).toEqual({
    key: "row-3",
    status: "pending",
    started_at: null,
    executor_finished_at: null,
    result: null,
  });
  const state = store.loadTaskState(taskId);
  state.task.version++;
  state.consumedInputIds.push("receipt-2" as never);
  required(state.outbox.find((r) => r.key === "row-2")).status = "succeeded";
  store.commit(
    taskId,
    {
      ...result(state),
      inputs: [{ inputId: "receipt-2" as never, accepted: true, reply: null }],
    },
    state.task.version - 1,
  );
  expect(store.outbox.recent(taskId)[0]).toMatchObject({
    status: "succeeded",
    result: rows[0]?.result,
  });
  const other = "other" as typeof taskId;
  store.createTask(task(other));
  expect(store.outbox.recent(other)).toEqual([]);
});
