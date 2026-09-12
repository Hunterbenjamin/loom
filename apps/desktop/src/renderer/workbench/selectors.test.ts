import { expect, test } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { attentionPanes, spaces, terminalList } from "./selectors.js";

test("session groups retain native names, dead panes, deterministic order and distinct attention", () => {
  const a = { ...pane, paneId: "%10", id: "ten", attention: true, dead: true };
  const b = {
    ...pane,
    paneId: "%3",
    id: "three",
    taskLabel: "t-1 · Build",
    role: "implementer",
    provider: "claude",
    attention: true,
  };
  expect(spaces([a, b])[0]?.panes).toEqual([b, a]);
  expect(spaces([a, b])[0]?.label).toBe("t-1 · Build");
  expect(spaces([a, b], "cld impl")[0]?.panes).toEqual([b]);
  expect(spaces([a], "missing")).toEqual([]);
  expect(attentionPanes([a, b])).toEqual([b, a]);
  expect(spaces([a])[0]?.label).toBe("research");
});

test("terminal list uses terminal names, excludes pinned sessions and never groups by issue", () => {
  const terminal = {
    ...pane,
    windowName: "Build logs",
    taskLabel: "Issue title",
    sessionName: "loom-task-1",
  };
  expect(terminalList([terminal])).toEqual([
    { pane: terminal, name: "Build logs" },
  ]);
  expect(terminalList([terminal], "Issue title")).toEqual([]);
  expect(terminalList([terminal], "build")).toHaveLength(1);
  expect(terminalList([{ ...terminal, dead: true }])).toEqual([]);
  expect(
    terminalList(
      ["loom-lead", "loom-main", "loom-operator"].map((sessionName) => ({
        ...terminal,
        sessionName,
      })),
    ),
  ).toEqual([]);
});
