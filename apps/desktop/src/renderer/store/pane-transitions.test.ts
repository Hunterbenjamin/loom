import type { Run } from "@loom/core";
import type { Change, PaneView } from "@loom/protocol";
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { describe, expect, it, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import {
  meta,
  snapshot,
} from "../../../../../packages/protocol/src/test-support.js";
import { createPaneTransitionDetector } from "./pane-transitions.js";
import { createStore } from "./store.js";

const working: PaneView = { ...pane, status: "working" };
const blocked: PaneView = { ...pane, status: "blocked", attention: true };
const ended: PaneView = { ...pane, status: "ended" };
const fixtureRun = snapshot().runs[0];
if (!fixtureRun) throw new Error("Missing run fixture");
const run: Run = {
  ...fixtureRun,
  pane: {
    hostGeneration: pane.hostGeneration,
    sessionName: pane.sessionName,
    windowId: pane.windowId,
    paneId: pane.paneId,
  },
};

describe("pane transitions", () => {
  it("is silent on initial discovery, repeated patches, and working to working", () => {
    const detector = createPaneTransitionDetector();
    expect(detector.observe([blocked], [])).toEqual([]);
    expect(detector.observe([blocked], [])).toEqual([]);
    expect(detector.observe([working], [])).toEqual([]);
    expect(detector.observe([{ ...working, attachedClients: 8 }], [])).toEqual(
      [],
    );
    expect(detector.observe([blocked], [])).toEqual([blocked]);
    expect(
      detector.observe([{ ...blocked, windowName: "Renamed" }], []),
    ).toEqual([]);
    expect(detector.observe([working], [])).toEqual([]);
    expect(detector.observe([ended], [])).toEqual([ended]);
    expect(detector.observe([ended], [])).toEqual([]);
  });

  it("chimes on starting to blocked and each separate entry into needs-you or done", () => {
    const detector = createPaneTransitionDetector();
    detector.observe([{ ...working, status: "starting" }], []);
    expect(detector.observe([blocked], [])).toEqual([blocked]);
    expect(detector.observe([ended], [])).toEqual([ended]);
    detector.observe([working], []);
    expect(detector.observe([blocked], [])).toEqual([blocked]);
  });

  it("uses recorded completed turns, never terminal exit or ordinary idle", () => {
    const detector = createPaneTransitionDetector();
    const linked = { ...working, runId: run.id };
    const idle = { ...linked, status: "idle" as const };
    detector.observe([linked], [run]);
    expect(detector.observe([idle], [{ ...run, lastTurn: null }])).toEqual([]);
    const finished: Run = {
      ...run,
      status: "idle",
      lastTurn: {
        id: "turn-1",
        outcome: "completed",
        error: null,
      },
    };
    expect(detector.observe([idle], [finished])).toEqual([idle]);
    expect(detector.observe([idle], [finished])).toEqual([]);
    const shell = { ...pane, dead: true };
    detector.observe([pane], []);
    expect(detector.observe([shell], [])).toEqual([]);
    detector.observe([linked], [run]);
    expect(
      detector.observe(
        [{ ...linked, status: "ended" }],
        [{ ...run, status: "ended", endReason: "crashed" }],
      ),
    ).toEqual([]);
  });

  it("baselines new generations, reappearing panes and unavailable observations", () => {
    const detector = createPaneTransitionDetector();
    detector.observe([working], []);
    expect(
      detector.observe([{ ...blocked, hostGeneration: "new-host" }], []),
    ).toEqual([]);
    detector.observe([], []);
    expect(detector.observe([blocked], [])).toEqual([]);
    detector.observe([working], []);
    expect(detector.observe([{ ...blocked, unavailable: true }], [])).toEqual(
      [],
    );
    expect(detector.observe([blocked], [])).toEqual([]);
    detector.observe([working], []);
    expect(detector.observe([blocked], [], true)).toEqual([]);
    expect(detector.observe([blocked], [])).toEqual([]);
  });

  it("publishes once per transition from the store, resets after disconnect and keeps mute window-local", () => {
    const store = createStore();
    const listener = vi.fn();
    const stop = store.subscribePaneTransitions(listener);
    const publish = (panes: PaneView[]) =>
      store.applyProtocol(
        stateFromSnapshot(meta, {
          ...emptySnapshotBody(),
          panes,
        }),
      );
    publish([working]);
    publish([blocked]);
    publish([blocked]);
    store.toggleChimeMuted();
    store.toast("unrelated UI change");
    expect(listener).toHaveBeenCalledExactlyOnceWith(blocked);
    expect(createStore().getState().ui.chimeMuted).toBe(false);
    store.setConnection("disconnected");
    publish([ended]);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    publish([working]);
    publish([blocked]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("handles pane and completed-turn patches in either order without duplicate notifications", () => {
    for (const runFirst of [true, false]) {
      const store = createStore();
      const linked = { ...working, runId: run.id };
      const client = stateFromSnapshot(meta, {
        ...emptySnapshotBody(),
        panes: [linked],
        runs: [{ ...run, status: "working", lastTurn: null }],
      });
      store.applyProtocol(client);
      const listener = vi.fn();
      store.subscribePaneTransitions(listener);
      const idle = { ...linked, status: "idle" as const };
      const finished: Run = {
        ...run,
        status: "idle",
        lastTurn: { id: "turn-1", outcome: "completed", error: null },
      };
      const paneChange: Change = {
        op: "upsert",
        collection: "pane",
        value: idle,
      };
      const runChange: Change = {
        op: "upsert",
        collection: "run",
        value: finished,
      };
      for (const change of runFirst
        ? [runChange, paneChange]
        : [paneChange, runChange]) {
        if (change.collection === "pane")
          client.collections.pane.set(idle.id, idle);
        else client.collections.run.set(finished.id, finished);
        const patch = {
          type: "patch" as const,
          seq: meta.seq,
          now: meta.now,
          changes: [change],
        };
        store.applyProtocol(client, patch);
        store.applyProtocol(client, patch);
      }
      expect(listener).toHaveBeenCalledExactlyOnceWith(idle);
    }
  });
});
