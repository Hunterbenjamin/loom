// Patches: per-collection upserts and deletes, ordered, with a sequence number per connection.
// No generic JSON patch. A client that sees a gap in the sequence asks for a fresh snapshot
// instead of guessing, because a half-applied stream is worse than a reload.

import { z } from "zod";
import { isoTime, seq, taskId } from "./ids.js";
import {
  COLLECTION_FIELDS,
  type CollectionName,
  collections,
  type Entities,
  emptySnapshotBody,
  keyOf,
  type SnapshotBody,
  type SnapshotMeta,
} from "./snapshot.js";

const upsert = <N extends CollectionName>(name: N) =>
  z.strictObject({
    op: z.literal("upsert"),
    collection: z.literal(name),
    value: collections[name].value as (typeof collections)[N]["value"],
  });

/**
 * A delete carries the task it belonged to, because the key alone can't be matched against a
 * client's subscriptions. Null for the two task-list-level collections.
 *
 * A `task` delete means "no longer yours": the task was removed, or it left the views this client
 * subscribed to. Either way the client drops it.
 */
const remove = <N extends CollectionName>(name: N) =>
  z.strictObject({
    op: z.literal("delete"),
    collection: z.literal(name),
    key: collections[name].key as (typeof collections)[N]["key"],
    taskId: taskId.nullable(),
  });

export const change = z.union([
  upsert("settings"),
  remove("settings"),
  upsert("project"),
  remove("project"),
  upsert("pull_requests"),
  remove("pull_requests"),
  upsert("pull_request"),
  remove("pull_request"),
  upsert("pull_request_detail"),
  remove("pull_request_detail"),
  upsert("note"),
  remove("note"),
  upsert("pane_inventory"),
  remove("pane_inventory"),
  upsert("pane"),
  remove("pane"),
  upsert("lead"),
  remove("lead"),
  upsert("inbox"),
  remove("inbox"),
  upsert("repo"),
  remove("repo"),
  upsert("task"),
  remove("task"),
  upsert("worktree"),
  remove("worktree"),
  upsert("run"),
  remove("run"),
  upsert("run_target"),
  remove("run_target"),
  upsert("message"),
  remove("message"),
  upsert("question"),
  remove("question"),
  upsert("finding"),
  remove("finding"),
  upsert("approval"),
  remove("approval"),
  upsert("plan"),
  remove("plan"),
  upsert("test_results"),
  remove("test_results"),
  upsert("transition"),
  remove("transition"),
  upsert("thread"),
  remove("thread"),
  upsert("review_state"),
  remove("review_state"),
  upsert("changes"),
  remove("changes"),
]);

export type Change = z.output<typeof change>;

export const patchBody = z.strictObject({
  /** One more than the last frame the coordinator sent this client. Contiguous, per connection. */
  seq,
  now: isoTime,
  /** Applied in order. Small on purpose: one patch is one reconcile's visible effect. */
  changes: z.array(change).min(1).max(2000),
});

export type PatchBody = z.output<typeof patchBody>;

// ---------------------------------------------------------------- client state

/** A client's copy of the snapshot, as maps so an upsert is a single write. */
export interface ClientState {
  seq: number;
  now: SnapshotMeta["now"];
  epoch: string;
  collections: { [N in CollectionName]: Map<string, Entities[N]> };
}

const emptyCollections = (): ClientState["collections"] => ({
  settings: new Map(),
  pull_requests: new Map(),
  pull_request: new Map(),
  pull_request_detail: new Map(),
  note: new Map(),
  pane_inventory: new Map(),
  pane: new Map(),
  lead: new Map(),
  project: new Map(),
  inbox: new Map(),
  repo: new Map(),
  task: new Map(),
  worktree: new Map(),
  run: new Map(),
  run_target: new Map(),
  message: new Map(),
  question: new Map(),
  finding: new Map(),
  approval: new Map(),
  plan: new Map(),
  test_results: new Map(),
  transition: new Map(),
  thread: new Map(),
  review_state: new Map(),
  changes: new Map(),
});

/** A fresh client state from a full snapshot. Replaces whatever the client held. */
export function stateFromSnapshot(
  meta: SnapshotMeta,
  body: SnapshotBody,
): ClientState {
  const state: ClientState = {
    seq: meta.seq,
    now: meta.now,
    epoch: meta.epoch,
    collections: emptyCollections(),
  };
  for (const name of Object.keys(collections) as CollectionName[]) {
    const rows = (body[COLLECTION_FIELDS[name]] ??
      []) as Entities[typeof name][];
    const map = state.collections[name] as Map<string, Entities[typeof name]>;
    for (const row of rows) map.set(keyOf(name, row), row);
  }
  return state;
}

/** The snapshot a client would send back: the same content a fresh snapshot gives. */
export function snapshotFromState(state: ClientState): SnapshotBody {
  const body = emptySnapshotBody();
  for (const name of Object.keys(collections) as CollectionName[]) {
    const rows = [
      ...state.collections[name].values(),
    ] as Entities[typeof name][];
    (body[COLLECTION_FIELDS[name]] as Entities[typeof name][]) = rows;
  }
  return body;
}

export type ApplyResult =
  | { ok: true; applied: number }
  /** The stream skipped ahead: ask for a fresh snapshot, don't apply. */
  | { ok: false; reason: "sequence_gap"; expected: number; received: number }
  /** Already applied: a reconnect replayed it. Nothing to do. */
  | { ok: false; reason: "stale"; expected: number; received: number };

/**
 * Applies one patch in place. The caller checks `ok` before rendering: on `sequence_gap` it sends
 * a `resync` and waits for the snapshot, which is the only recovery.
 */
export function applyPatch(state: ClientState, patch: PatchBody): ApplyResult {
  const expected = state.seq + 1;
  if (patch.seq < expected)
    return { ok: false, reason: "stale", expected, received: patch.seq };
  if (patch.seq > expected)
    return { ok: false, reason: "sequence_gap", expected, received: patch.seq };
  for (const entry of patch.changes) {
    const map = state.collections[entry.collection] as Map<string, unknown>;
    if (entry.op === "delete") map.delete(entry.key as string);
    else map.set(keyOf(entry.collection, entry.value as never), entry.value);
  }
  state.seq = patch.seq;
  state.now = patch.now;
  return { ok: true, applied: patch.changes.length };
}
