import type { Run } from "@loom/core";
import { expect, test } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { buildSnapshot } from "../fixtures/index.js";
import { attentionPanes, paneIndicator, spaces } from "./selectors.js";

const rows = (tree: ReturnType<typeof spaces>) =>
  tree.flatMap((space) =>
    space.tabs.flatMap((tab) => tab.panes.map(({ pane }) => pane)),
  );

test("groups by generation, session and window identity with deterministic native ordering", () => {
  const ten = {
    ...pane,
    paneId: "%10",
    id: "ten",
    windowId: "@10",
    windowName: "same",
    dead: true,
  };
  const three = {
    ...pane,
    paneId: "%3",
    id: "three",
    windowId: "@2",
    windowName: "same",
    taskLabel: "t-1 · Build",
    role: "implementer",
    provider: "claude",
    attention: true,
  };
  const two = { ...three, paneId: "%2", id: "two", taskLabel: null };
  const other = { ...pane, sessionName: "aaa", sessionId: "$99", id: "other" };
  const generation = {
    ...pane,
    hostGeneration: "loom-test#2",
    id: "generation",
  };
  const tree = spaces([ten, three, generation, other, two]);
  expect(tree.map((space) => space.name)).toEqual([
    "aaa",
    "research",
    "research",
  ]);
  expect(tree[1]?.label).toBe("t-1 · Build");
  expect(
    tree[1]?.tabs.map((tab) => tab.panes.map(({ pane }) => pane.paneId)),
  ).toEqual([["%2", "%3"], ["%10"]]);
  expect(tree[1]?.tabs[0]?.key).not.toBe(tree[1]?.tabs[1]?.key);
  expect(new Set(tree.map((space) => space.key)).size).toBe(3);
  expect(rows(spaces([ten]))).toEqual([ten]);
  expect(attentionPanes([three, two, { ...ten, attention: true }])).toEqual([
    two,
    three,
  ]);
  expect(spaces([pane])[0]?.label).toBe("research");
});

test("rolls up needs-you > failed > unknown > working > done > idle at both levels", () => {
  const statuses = ["blocked", "failed", "unknown", "working", "ended", "idle"];
  const icons = ["◐", "!", "?", "◌", "✓", "○"];
  for (let i = 0; i < statuses.length; i++) {
    const panes = statuses.slice(i).map((status, n) => ({
      ...pane,
      status,
      paneId: `%${n}`,
      windowId: `@${n}`,
    }));
    expect(spaces(panes)[0]?.indicator.icon).toBe(icons[i]);
    const singleTab = spaces(panes.map((p) => ({ ...p, windowId: "@1" })))[0];
    expect(singleTab?.indicator.icon).toBe(icons[i]);
    expect(singleTab?.tabs[0]?.indicator.icon).toBe(icons[i]);
  }
  expect(
    paneIndicator({ ...pane, status: "failed", attention: true }).icon,
  ).toBe("◐");
  expect(paneIndicator({ ...pane, unavailable: true }).icon).toBe("?");
  expect(paneIndicator({ ...pane, status: "new-provider-status" }).icon).toBe(
    "?",
  );
  expect(paneIndicator({ ...pane, status: "starting" }).icon).toBe("◌");
  // A native exit, title or command cannot imply a provider completed a turn.
  expect(
    paneIndicator({ ...pane, dead: true, command: "done", title: "failed" })
      .icon,
  ).toBe("○");
});

test("finished turns use only an exactly linked recorded run", () => {
  const run = {
    ...buildSnapshot().runs[0],
    pane,
    lastTurn: { id: "turn-1", outcome: "completed", error: null },
  } as Run;
  const linked = { ...pane, runId: run.id, status: "idle" };
  expect(paneIndicator(linked, run).label).toBe("Finished turn");
  expect(
    paneIndicator({ ...linked, hostGeneration: "different" }, run).icon,
  ).toBe("○");
  expect(paneIndicator({ ...linked, status: null }).icon).toBe("?");
});

test("fuzzy filter retains ancestors, matches task and native names, and keeps full rollups", () => {
  const agent = {
    ...pane,
    paneId: "%3",
    taskLabel: "t-1 · Build",
    role: "implementer",
    provider: "claude",
    status: "working",
  };
  const blocked = { ...pane, paneId: "%4", command: "codex", attention: true };
  const tree = spaces([agent, blocked], "cld impl");
  expect(rows(tree)).toEqual([agent]);
  expect(tree[0]?.indicator.icon).toBe("◐");
  expect(tree[0]?.tabs[0]?.indicator.icon).toBe("◐");
  expect(rows(spaces([agent, blocked], "bld"))).toEqual([agent, blocked]);
  expect(rows(spaces([agent, blocked], "rsc shl"))).toEqual([agent, blocked]);
  expect(spaces([agent], "missing")).toEqual([]);
  expect(spaces([agent], "  ")).toEqual(spaces([agent]));
});

test("pinned Main and Operator sessions are excluded from the space tree", () => {
  expect(
    spaces(
      ["loom-main", "loom-lead", "loom-operator"].map((sessionName) => ({
        ...pane,
        sessionName,
      })),
    ),
  ).toEqual([]);
});
