import { describe, expect, it } from "vitest";
import {
  applyPatch,
  type Change,
  change,
  patchBody,
  snapshotFromState,
  stateFromSnapshot,
} from "./patch.js";
import { COLLECTION_NAMES, keyOf } from "./snapshot.js";
import { after, at, id, meta, snapshot, stream } from "./test-support.js";

/** The same content, however the rows happen to be ordered. */
const sorted = (body: ReturnType<typeof snapshot>) =>
  Object.fromEntries(
    Object.entries(body).map(([field, rows]) => [
      field,
      [...rows].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ]),
  );

describe("a fake client", () => {
  it("ends where a fresh snapshot would after applying the stream", () => {
    const client = stateFromSnapshot(meta, snapshot());
    const patches = stream(snapshot());
    for (const patch of patches)
      expect(applyPatch(client, patch)).toEqual({
        ok: true,
        applied: patch.changes.length,
      });
    expect(client.seq).toBe(meta.seq + patches.length);
    expect(client.now).toBe(patches[patches.length - 1]?.now);

    // What a window connecting now would be sent, written by hand in test-support.
    const fresh = stateFromSnapshot({ ...meta, seq: client.seq }, after());
    expect(sorted(snapshotFromState(client))).toEqual(
      sorted(snapshotFromState(fresh)),
    );
  });

  it("applies upserts and deletes to the right collections", () => {
    const body = snapshot();
    const client = stateFromSnapshot(meta, body);
    const before = client.collections.finding.get("LOOM-101-f1");
    expect(before?.status).toBe("open");
    for (const patch of stream(body)) applyPatch(client, patch);
    expect(client.collections.finding.get("LOOM-101-f1")?.status).toBe(
      "resolved",
    );
    expect(client.collections.question.size).toBe(0);
    expect([...client.collections.task.keys()]).toEqual(["LOOM-101"]);
    expect(client.collections.task.get("LOOM-101")?.attention.reasons).toEqual([
      "stalled",
    ]);
    // Untouched collections keep their rows.
    expect(client.collections.run.size).toBe(2);
  });

  it("detects a gap in the sequence and applies nothing", () => {
    const body = snapshot();
    const client = stateFromSnapshot(meta, body);
    const [first, second] = stream(body);
    if (!first || !second) throw new Error("sample changed");
    expect(applyPatch(client, second)).toEqual({
      ok: false,
      reason: "sequence_gap",
      expected: meta.seq + 1,
      received: meta.seq + 2,
    });
    expect(client.seq).toBe(meta.seq);
    expect(client.collections.question.size).toBe(1);
    // The recovery is a fresh snapshot, and the stream continues from its seq.
    const resynced = stateFromSnapshot({ ...meta, seq: second.seq }, body);
    expect(applyPatch(resynced, { ...second, seq: second.seq + 1 }).ok).toBe(
      true,
    );
  });

  it("ignores a patch it has already applied", () => {
    const body = snapshot();
    const client = stateFromSnapshot(meta, body);
    const [first] = stream(body);
    if (!first) throw new Error("sample changed");
    expect(applyPatch(client, first).ok).toBe(true);
    expect(applyPatch(client, first)).toEqual({
      ok: false,
      reason: "stale",
      expected: meta.seq + 2,
      received: meta.seq + 1,
    });
    expect(client.seq).toBe(meta.seq + 1);
  });
});

describe("the patch schema", () => {
  it("round-trips every change through JSON", () => {
    for (const patch of stream(snapshot())) {
      const parsed = patchBody.parse(JSON.parse(JSON.stringify(patch)));
      expect(parsed).toEqual(patch);
    }
  });

  it("covers every collection in both directions", () => {
    const collections = new Set<string>();
    for (const entry of change._zod.def.options) {
      const shape = (
        entry as { _zod: { def: { shape: Record<string, unknown> } } }
      )._zod.def.shape;
      const literal = shape.collection as {
        _zod: { def: { values: string[] } };
      };
      for (const value of literal._zod.def.values) collections.add(value);
    }
    expect([...collections].sort()).toEqual([...COLLECTION_NAMES].sort());
  });

  it("refuses an empty patch, so a frame always means something changed", () => {
    expect(
      patchBody.safeParse({
        seq: 1,
        now: at("2026-09-12T09:00:00.000Z"),
        changes: [],
      }).success,
    ).toBe(false);
  });

  it("keys every collection by the field the coordinator writes", () => {
    const body = snapshot();
    expect(keyOf("task", body.tasks[0] as never)).toBe("LOOM-101");
    expect(keyOf("worktree", body.worktrees[0] as never)).toBe(
      "/private/var/loom/wt/LOOM-101",
    );
    expect(keyOf("changes", body.changes[0] as never)).toBe(
      "LOOM-101#whole_branch",
    );
    expect(keyOf("plan", body.plans[0] as never)).toBe("LOOM-101");
  });

  it("carries the owning task on a delete, so a client can be filtered", () => {
    const remove: Change = {
      op: "delete",
      collection: "finding",
      key: id.finding("LOOM-101-f1"),
      taskId: id.task("LOOM-101"),
    };
    expect(change.parse(JSON.parse(JSON.stringify(remove)))).toEqual(remove);
    const { taskId: _dropped, ...missing } = remove;
    expect(change.safeParse(missing).success).toBe(false);
  });
});
