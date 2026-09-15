import type { Run } from "@loom/core";
import { expect, test } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { buildSnapshot } from "../fixtures/index.js";
import {
  attentionPanes,
  paneIndicator,
  spaces,
  workbenchSessions,
} from "./selectors.js";

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
    taskName: "Build",
    issueKey: "LOOM-1",
    taskStage: "in_progress" as const,
    role: "implementer",
    provider: "claude",
    attention: true,
  };
  const two = { ...three, paneId: "%2", id: "two", taskName: null };
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
  expect(tree[1]?.label).toBe("Build");
  expect(tree[1]?.subtext).toBe("LOOM-1 · in progress");
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
  const icons = ["●", "!", "?", "◌", "●", "○"];
  for (let i = 0; i < statuses.length; i++) {
    const panes = statuses.slice(i).map((status, n) => ({
      ...pane,
      status,
      attention: status === "blocked",
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
  ).toBe("●");
  expect(paneIndicator({ ...pane, unavailable: true }).icon).toBe("?");
  expect(paneIndicator({ ...pane, status: "new-provider-status" }).icon).toBe(
    "?",
  );
  expect(paneIndicator({ ...pane, status: "starting" }).icon).toBe("◌");
  // A native exit, title or command cannot imply a provider completed a turn.
  expect(
    paneIndicator({
      ...pane,
      dead: true,
      command: "done",
      paneTitle: "failed",
    }).icon,
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

test("linked runs preserve specific blocked labels", () => {
  const run = {
    ...buildSnapshot().runs[0],
    pane,
    status: "blocked" as const,
    blockedOn: "permission" as const,
  } as Run;
  const linked = { ...pane, runId: run.id, status: "blocked", attention: true };
  expect(paneIndicator(linked, run).label).toBe("Awaiting permission");
  expect(paneIndicator(linked, { ...run, blockedOn: "rate_limit" }).label).toBe(
    "Rate limited",
  );
});

test("fuzzy filter retains ancestors, matches task and native names, and keeps full rollups", () => {
  const agent = {
    ...pane,
    paneId: "%3",
    taskName: "Build",
    issueKey: "LOOM-1",
    taskStage: "in_progress" as const,
    role: "implementer",
    provider: "claude",
    status: "working",
  };
  const blocked = { ...pane, paneId: "%4", command: "codex", attention: true };
  const tree = spaces([agent, blocked], "cld impl");
  expect(rows(tree)).toEqual([agent]);
  expect(tree[0]?.indicator.icon).toBe("●");
  expect(tree[0]?.tabs[0]?.indicator.icon).toBe("●");
  expect(rows(spaces([agent, blocked], "bld"))).toEqual([agent, blocked]);
  expect(rows(spaces([agent, blocked], "rsc shl"))).toEqual([agent, blocked]);
  expect(spaces([agent], "missing")).toEqual([]);
  expect(spaces([agent], "  ")).toEqual(spaces([agent]));
});

test("pinned and workbench sessions are excluded from the space tree", () => {
  const legacy = ["loom-main", "loom-lead"].map((sessionName) => ({
    ...pane,
    sessionName,
  }));
  expect(
    rows(spaces(legacy))
      .map((item) => item.sessionName)
      .sort(),
  ).toEqual(["loom-lead", "loom-main"]);
  const hidden = ["loom-lead-repo", "loom-coordinator", "loom-desktop"].map(
    (sessionName, index) => ({
      ...pane,
      sessionName,
      sessionId: `$${index}`,
    }),
  );
  expect(spaces(hidden)).toEqual([]);
  expect(
    attentionPanes(hidden.map((item) => ({ ...item, attention: true }))),
  ).toEqual([]);
  expect(
    workbenchSessions(hidden).map(({ name, label }) => ({ name, label })),
  ).toEqual([
    { name: "loom-coordinator", label: "Coordinator" },
    { name: "loom-desktop", label: "Desktop" },
  ]);
});

test("titles override display defaults without changing grouping or indicators", () => {
  const linkedRun = {
    ...buildSnapshot().runs[0],
    pane,
    role: "reviewer" as const,
    round: 2,
    status: "working" as const,
  } as Run;
  const titled = {
    ...pane,
    taskName: "Issue default",
    runId: linkedRun.id,
    role: linkedRun.role,
    provider: linkedRun.provider,
    status: linkedRun.status,
    spaceTitle: "Space title",
    tabTitle: "Tab title",
    paneTitle: "Agent title",
  };
  const sibling = {
    ...titled,
    id: "sibling",
    paneId: "%9",
    runId: null,
    role: null,
    provider: null,
    status: null,
    paneTitle: null,
    command: "zsh",
  };
  const tree = spaces([titled, sibling], "", [linkedRun]);
  expect(tree[0]).toMatchObject({
    name: pane.sessionName,
    label: "Space title",
    indicator: { icon: "◌" },
    tabs: [
      {
        name: "Tab title",
        indicator: { icon: "◌" },
        panes: [
          { name: "Agent title", indicator: { icon: "◌" } },
          { name: "zsh", indicator: { icon: "○" } },
        ],
      },
    ],
  });
  const cleared = spaces(
    [
      {
        ...titled,
        spaceTitle: null,
        tabTitle: null,
        paneTitle: null,
      },
    ],
    "",
    [linkedRun],
  )[0];
  expect(cleared?.label).toBe("Issue default");
  expect(cleared?.tabs[0]?.name).toContain("Reviewer");
  expect(cleared?.tabs[0]?.panes[0]?.name).toContain("Reviewer");
});

test("titles do not affect pinned Main or service identity", () => {
  const main = {
    ...pane,
    sessionName: "loom-lead-repo",
    spaceTitle: "Friendly Main",
  };
  const service = {
    ...pane,
    sessionName: "loom-coordinator",
    sessionId: "$8",
    spaceTitle: "Friendly service",
  };
  expect(spaces([main, service])).toEqual([]);
  expect(workbenchSessions([main, service])).toMatchObject([
    { name: "loom-coordinator", label: "Coordinator" },
  ]);
});

test("tree row projection contains only spaces and native tabs with full rollups and window index order", () => {
  const tree = spaces([
    {
      ...pane,
      windowId: "@2",
      windowIndex: 5,
      windowName: "Shell",
      command: "zsh",
    },
    {
      ...pane,
      paneId: "%8",
      windowId: "@8",
      windowIndex: 0,
      windowName: "Build",
      command: "node",
      status: "working",
    },
    {
      ...pane,
      paneId: "%9",
      windowId: "@8",
      windowIndex: 0,
      windowName: "Build",
      command: "codex",
      status: "blocked",
    },
  ]);
  const rows = tree.flatMap((space) => [
    { kind: "space", name: space.name, status: space.indicator.label },
    ...space.tabs.map((tab) => ({
      kind: "tab",
      name: tab.name,
      status: tab.indicator.label,
    })),
  ]);
  expect(rows).toMatchInlineSnapshot(`
    [
      {
        "kind": "space",
        "name": "research",
        "status": "Blocked",
      },
      {
        "kind": "tab",
        "name": "Build",
        "status": "Blocked",
      },
      {
        "kind": "tab",
        "name": "Shell",
        "status": "Idle",
      },
    ]
  `);
});
