// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { cursorRows, selectedRows } from "../store/selectors.js";
import { boardCursor, createShortcutHandler } from "./keys.js";
import { registerTrackerActions } from "./tracker-actions.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
});
function setup() {
  const store = createStore(buildSnapshot(20));
  const help = vi.fn();
  const pending = vi.fn();
  const handler = createShortcutHandler(store, help, pending);
  window.addEventListener("keydown", handler);
  cleanups.push(() => window.removeEventListener("keydown", handler));
  const key = (
    key: string,
    target: EventTarget = document.body,
    options: KeyboardEventInit = {},
  ) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { store, help, key, pending };
}
test("section chords, view toggle and help", () => {
  const { store, help, key } = setup();
  for (const [letter, view] of [
    ["n", "needs-you"],
    ["r", "pull-requests"],
    ["d", "briefs"],
    ["s", "settings"],
    ["i", "all"],
  ]) {
    key("g");
    key(letter!);
    expect(store.getState().ui.view).toBe(view);
  }
  key("v");
  expect(store.getState().ui.pane).toBe("board");
  key("v");
  expect(store.getState().ui.pane).toBe("list");
  key("?");
  expect(help).toHaveBeenCalledOnce();
  key("c");
  expect(store.getState().ui.createIssue).toBe(true);
});
test("prefix waits without timeout and Escape or unmapped keys cancel", () => {
  vi.useFakeTimers();
  const { store, key, pending } = setup();
  key("g");
  expect(pending).toHaveBeenLastCalledWith(true);
  vi.advanceTimersByTime(60_000);
  key("n");
  expect(store.getState().ui.view).toBe("needs-you");
  expect(pending).toHaveBeenLastCalledWith(false);
  for (const cancel of ["Escape", "q", "a", "b"]) {
    key("g");
    key(cancel);
    key("i");
    expect(store.getState().ui.view).toBe("needs-you");
  }
});
test("typing, terminals, composition and dialogs own all keys", () => {
  const { store, help, key } = setup();
  document.body.innerHTML =
    '<input><textarea></textarea><select></select><div contenteditable="true"><span></span></div><div class="xterm"><span></span></div>';
  for (const target of document.querySelectorAll(
    "input, textarea, select, span",
  )) {
    key("g");
    key("n", target);
    key("c", target);
    key("?", target);
    key("k", target, { metaKey: true });
    expect(store.getState().ui.view).toBe("all");
    expect(store.getState().ui.createIssue).toBe(false);
    expect(store.getState().ui.palette).toBe(false);
  }
  key("c", document.body, { isComposing: true });
  document.body.innerHTML = "<dialog open></dialog>";
  key("c");
  key("?");
  expect(store.getState().ui.createIssue).toBe(false);
  expect(help).not.toHaveBeenCalled();
});
test("detail actions dispatch by id; removed keys and repeated approval do nothing", () => {
  const { store, key } = setup();
  const task = store.getState().snapshot.tasks[0]!;
  store.open(task.id);
  store.setCursor(2);
  const approve = vi.fn(),
    edit = vi.fn(),
    tab = vi.fn(),
    scroll = vi.fn(),
    change = vi.fn();
  cleanups.push(
    registerTrackerActions(store, {
      approve,
      edit,
      "tab-plan": tab,
      "scroll-down": scroll,
      change,
    }),
  );
  key("a");
  key("a", document.body, { repeat: true });
  expect(approve).toHaveBeenCalledOnce();
  key("e");
  key("2");
  key("j");
  key("x");
  expect(edit).toHaveBeenCalledOnce();
  expect(tab).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledOnce();
  for (const removed of ["E", "t", "A", "C"]) key(removed);
  expect(edit).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledOnce();
  expect(store.getState().ui.createIssue).toBe(false);
  expect(store.getState().ui.cursor).toBe(2);
  key("s");
  expect(store.getState().ui.stagePicker).toBe(true);
});
test("diff file keys leave j/k for scrolling and hunk keys take precedence", () => {
  const { store, key } = setup();
  store.open(store.getState().snapshot.tasks[0]!.id);
  const scroll = vi.fn(),
    file = vi.fn(),
    previousFile = vi.fn(),
    hunk = vi.fn();
  cleanups.push(
    registerTrackerActions(store, {
      "scroll-down": scroll,
      "next-issue": scroll,
    }),
  );
  const remove = registerTrackerActions(store, {
    "next-file": file,
    "previous-file": previousFile,
    "next-hunk": hunk,
  });
  key("n");
  key("p");
  expect(previousFile).toHaveBeenCalledOnce();
  key("]");
  expect(file).toHaveBeenCalledOnce();
  expect(hunk).toHaveBeenCalledOnce();
  expect(scroll).not.toHaveBeenCalled();
  remove();
  key("j");
  expect(scroll).toHaveBeenCalledOnce();
});
test("list endpoints, filter action and adjacent issues preserve the detail tab", () => {
  const { store, key } = setup();
  const focus = vi.fn();
  cleanups.push(registerTrackerActions(store, { filter: focus }));
  key("/");
  expect(focus).toHaveBeenCalledOnce();
  const rows = cursorRows(store.getState());
  key("G");
  expect(store.getState().ui.cursor).toBe(rows.length - 1);
  key("g");
  key("g");
  expect(store.getState().ui.cursor).toBe(0);
  key("Enter");
  store.setTab("plan");
  key("]");
  expect(store.getState().ui.openTask).toBe(rows[1]!.task.id);
  expect(store.getState().ui.tab).toBe("plan");
  key("[");
  expect(store.getState().ui.openTask).toBe(rows[0]!.task.id);
});
test("board movement stays in columns, skips empty ones and handles stale cursors", () => {
  const { store, key } = setup();
  const rows = selectedRows(store.getState()).slice(0, 3);
  rows[0]!.task.stage = "backlog";
  rows[1]!.task.stage = "backlog";
  rows[2]!.task.stage = "ci";
  expect(boardCursor(rows, null, "next-row")).toBe(0);
  expect(boardCursor(rows, 0, "next-row")).toBe(1);
  expect(boardCursor(rows, 1, "next-row")).toBe(1);
  expect(boardCursor(rows, 1, "right-column")).toBe(2);
  expect(boardCursor(rows, 2, "left-column")).toBe(0);
  expect(boardCursor(rows, 99, "previous-row")).toBe(0);
  expect(boardCursor([], null, "next-row")).toBeNull();
  store.setPane("board");
  key("j");
  key("Enter");
  expect(store.getState().ui.openTask).not.toBeNull();
});
test("stage and palette issue commands use visible selection and ignore non-issue lists", async () => {
  const { paletteIssueTarget } = await import("./palette.js");
  const { inboxRows } = await import("../store/inbox.js");
  const { store } = setup();
  store.setCursor(0);
  expect(paletteIssueTarget(store.getState())).not.toBeNull();
  for (const view of ["briefs", "settings", "pull-requests"] as const) {
    store.setView(view);
    store.setCursor(0);
    expect(paletteIssueTarget(store.getState())).toBeNull();
  }
  store.setView("needs-you");
  const rows = inboxRows(store.getState());
  expect(rows.length).toBeGreaterThan(0);
  for (let index = 0; index < rows.length; index++) {
    store.setCursor(index);
    expect(paletteIssueTarget(store.getState())).toBe(rows[index]!.task.id);
  }
});

test("row navigation leaves old control focus so Enter opens the selected row", () => {
  const { store, key } = setup();
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  key("G", button);
  expect(document.activeElement).not.toBe(button);
  key("Enter", document.activeElement!);
  expect(store.getState().ui.openTask).not.toBeNull();
});

test("every binding has a unique action id and registry cleanup removes only its owner", async () => {
  const { trackerKeymap } = await import("./tracker-keymap.js");
  const { hasTrackerAction } = await import("./tracker-actions.js");
  expect(new Set(trackerKeymap.map((entry) => entry.id)).size).toBe(
    trackerKeymap.length,
  );
  const { store } = setup();
  for (const entry of trackerKeymap) {
    expect(entry.keys.length).toBeGreaterThan(0);
    const remove = registerTrackerActions(store, { [entry.id]: () => {} });
    expect(hasTrackerAction(store, entry.id)).toBe(true);
    remove();
    expect(hasTrackerAction(store, entry.id)).toBe(false);
  }
});

test("standard scroll bindings repeat, expose hints, and stay paused while typing", async () => {
  const { store, key } = setup();
  const { formatKeys, keyHint } = await import("./tracker-keymap.js");
  store.open(store.getState().snapshot.tasks[0]!.id);
  const actions = {
    "half-page-down": vi.fn(),
    "half-page-up": vi.fn(),
    "page-down": vi.fn(),
    "page-up": vi.fn(),
  };
  cleanups.push(registerTrackerActions(store, actions));
  const bindings = [
    ["d", { ctrlKey: true }, "half-page-down"],
    ["u", { ctrlKey: true }, "half-page-up"],
    [" ", {}, "page-down"],
    [" ", { shiftKey: true }, "page-up"],
  ] as const;
  document.body.innerHTML =
    '<input><textarea></textarea><select></select><div contenteditable="true"><span></span></div><div class="xterm"><span></span></div>';
  for (const [letter, options, id] of bindings) {
    expect(key(letter, document.body, options).defaultPrevented).toBe(true);
    key(letter, document.body, { ...options, repeat: true });
    expect(actions[id]).toHaveBeenCalledTimes(2);
    for (const target of document.querySelectorAll(
      "input, textarea, select, span",
    )) {
      expect(key(letter, target, options).defaultPrevented).toBe(false);
    }
    expect(actions[id]).toHaveBeenCalledTimes(2);
  }
  expect(key("J", document.body, { shiftKey: true }).defaultPrevented).toBe(
    false,
  );
  expect(key("K", document.body, { shiftKey: true }).defaultPrevented).toBe(
    false,
  );
  expect(formatKeys("half-page-down")).toBe("Ctrl+D");
  expect(formatKeys("page-up")).toBe("Shift+Space");
  expect(keyHint("page-up")["aria-keyshortcuts"]).toBe("Shift+Space");
});
