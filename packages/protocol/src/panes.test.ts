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
  expect(command.safeParse({ kind: "close_terminal", target }).success).toBe(
    true,
  );
  expect(
    command.safeParse({
      kind: "close_terminal",
      target: { ...target, paneId: "*" },
    }).success,
  ).toBe(false);
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

test("set_title uses native IDs and validates display titles at the boundary", () => {
  const base = {
    kind: "set_title",
    hostGeneration: pane.hostGeneration,
    title: "My title",
  };
  for (const target of [
    { kind: "space", sessionId: "$1" },
    { kind: "tab", windowId: "@1" },
    { kind: "pane", paneId: "%1" },
  ])
    expect(command.safeParse({ ...base, target }).success).toBe(true);
  expect(
    command.parse({
      ...base,
      target: { kind: "pane", paneId: "%1" },
      title: "  ",
    }),
  ).toMatchObject({ title: "" });
  for (const title of ["x".repeat(81), "bad\nname"])
    expect(
      command.safeParse({
        ...base,
        target: { kind: "space", sessionId: "$1" },
        title,
      }).success,
    ).toBe(false);
  for (const target of [
    { kind: "space", sessionId: "*" },
    { kind: "tab", windowId: "*" },
    { kind: "pane", paneId: "*" },
    { kind: "pane", paneId: "%1", extra: true },
  ])
    expect(command.safeParse({ ...base, target }).success).toBe(false);
  expect(
    command.safeParse({
      ...base,
      target: { kind: "pane", paneId: "%1" },
      extra: true,
    }).success,
  ).toBe(false);
  expect(ackResult.parse({ kind: "titled" })).toEqual({ kind: "titled" });
});
