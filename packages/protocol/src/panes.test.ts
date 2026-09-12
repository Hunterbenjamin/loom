import { expect, test } from "vitest";
import { ackResult, command } from "./commands.js";
import { pane } from "./pane-fixture.js";
import { applyPatch, snapshotFromState, stateFromSnapshot } from "./patch.js";
import { emptySnapshotBody } from "./snapshot.js";
import { inScope, scopeOf } from "./subscriptions.js";
import { meta } from "./test-support.js";
import { paneIdentity, paneView } from "./views.js";

test("panes snapshot and keyed patches roundtrip and follow only panes subscription", () => {
  const state = stateFromSnapshot(meta, {
    ...emptySnapshotBody(),
    panes: [pane],
  });
  const updated = { ...pane, dead: true, exitStatus: 7 };
  const change = { op: "upsert", collection: "pane", value: updated } as const;
  expect(inScope(scopeOf([]), change)).toBe(false);
  expect(inScope(scopeOf([{ kind: "panes" }]), change)).toBe(true);
  expect(
    applyPatch(state, { seq: meta.seq + 1, now: meta.now, changes: [change] })
      .ok,
  ).toBe(true);
  expect(snapshotFromState(state).panes).toEqual([updated]);
  const deletion = {
    op: "delete",
    collection: "pane",
    key: pane.id,
    taskId: null,
  } as const;
  expect(inScope(scopeOf([{ kind: "panes" }]), deletion)).toBe(true);
  applyPatch(state, { seq: meta.seq + 2, now: meta.now, changes: [deletion] });
  expect(snapshotFromState(state).panes).toEqual([]);
});
test("validates identities, native fields and scratch acknowledgements", () => {
  const target = paneIdentity.parse(
    paneIdentity.shape
      ? {
          hostGeneration: pane.hostGeneration,
          sessionName: pane.sessionName,
          windowId: pane.windowId,
          paneId: pane.paneId,
        }
      : {},
  );
  expect(command.safeParse({ kind: "open_pane_session", target }).success).toBe(
    true,
  );
  expect(
    command.safeParse({
      kind: "open_pane_session",
      target: { ...target, argv: ["sh"] },
    }).success,
  ).toBe(false);
  expect(
    command.safeParse({
      kind: "open_pane_session",
      target: { ...target, paneId: "abc" },
    }).success,
  ).toBe(false);
  expect(paneView.safeParse({ ...pane, id: "guessed" }).success).toBe(false);
  expect(ackResult.safeParse({ kind: "scratch_created", pane }).success).toBe(
    true,
  );
  expect(
    command.safeParse({
      kind: "create_scratch",
      taskId: "t-1",
      key: crypto.randomUUID(),
    }).success,
  ).toBe(true);
});
