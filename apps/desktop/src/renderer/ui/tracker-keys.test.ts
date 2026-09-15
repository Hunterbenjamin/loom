// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { selectedRows } from "../store/selectors.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { boardCursor, createShortcutHandler } from "./keys.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
});
function setup() {
  const store = createStore(buildSnapshot(20));
  const help = vi.fn();
  const handler = createShortcutHandler(store, help);
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
  return { store, help, key };
}
test("section chords, legacy pane chords and help", () => {
  const { store, help, key } = setup();
  for (const [letter, view] of [
    ["n", "needs-you"],
    ["r", "pull-requests"],
    ["d", "briefs"],
    ["s", "settings"],
    ["a", "all"],
  ]) {
    key("g");
    key(letter!);
    expect(store.getState().ui.view).toBe(view);
  }
  key("g");
  key("b");
  expect(store.getState().ui.pane).toBe("board");
  key("g");
  key("i");
  expect(store.getState().ui.pane).toBe("list");
  key("?");
  expect(help).toHaveBeenCalledOnce();
  key("c");
  expect(store.getState().ui.createIssue).toBe(true);
});
test("prefix expiration and canceled prefixes do not navigate", () => {
  vi.useFakeTimers();
  const { store, key } = setup();
  key("g");
  vi.advanceTimersByTime(901);
  key("n");
  expect(store.getState().ui.view).toBe("all");
  key("g");
  key("Escape");
  key("n");
  expect(store.getState().ui.view).toBe("all");
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
test("details consume navigation and activate only enabled controls on the detail", () => {
  const { store, key } = setup();
  const task = store.getState().snapshot.tasks[0]!;
  store.open(task.id);
  store.setCursor(2);
  document.body.innerHTML =
    '<button data-issue-action="approve-plan"></button><div class="detail"><div class="pr-page-body"></div><button data-tab="plan"></button><button data-issue-action="approve-plan" disabled></button><button data-issue-action="edit"></button></div>';
  const outside = vi.fn();
  const approve = vi.fn();
  const edit = vi.fn();
  const tab = vi.fn();
  document.querySelector("button")!.addEventListener("click", outside);
  const disabled = document.querySelector<HTMLButtonElement>(
    ".detail [data-issue-action=approve-plan]",
  )!;
  disabled.addEventListener("click", approve);
  document
    .querySelector("[data-issue-action=edit]")!
    .addEventListener("click", edit);
  document.querySelector("[data-tab=plan]")!.addEventListener("click", tab);
  key("a");
  expect(approve).not.toHaveBeenCalled();
  expect(outside).not.toHaveBeenCalled();
  disabled.disabled = false;
  key("a");
  key("a", document.body, { repeat: true });
  expect(approve).toHaveBeenCalledOnce();
  key("E");
  expect(edit).toHaveBeenCalledOnce();
  key("2");
  expect(tab).toHaveBeenCalledOnce();
  key("j");
  key("Enter");
  expect(store.getState().ui.cursor).toBe(2);
  expect(store.getState().ui.openTask).toBe(task.id);
  expect(document.querySelector(".pr-page-body")!.scrollTop).toBe(60);
  const event = key("Enter", disabled);
  expect(event.defaultPrevented).toBe(false);
});
test("board movement stays in columns, skips empty ones and handles stale cursors", () => {
  const { store, key } = setup();
  const rows = selectedRows(store.getState()).slice(0, 3);
  rows[0]!.task.stage = "backlog";
  rows[1]!.task.stage = "backlog";
  rows[2]!.task.stage = "ci";
  expect(boardCursor(rows, null, "j")).toBe(0);
  expect(boardCursor(rows, 0, "j")).toBe(1);
  expect(boardCursor(rows, 1, "j")).toBe(1);
  expect(boardCursor(rows, 1, "l")).toBe(2);
  expect(boardCursor(rows, 2, "h")).toBe(0);
  expect(boardCursor(rows, 99, "k")).toBe(0);
  expect(boardCursor([], null, "j")).toBeNull();
  store.setPane("board");
  key("j");
  key("Enter");
  expect(store.getState().ui.openTask).not.toBeNull();
});
test("brief navigation opens a brief and never an issue", () => {
  const { store, key } = setup();
  store.setView("briefs");
  document.body.innerHTML =
    '<div data-brief="one"></div><div data-brief="two"></div>';
  const rows = document.querySelectorAll<HTMLElement>("[data-brief]");
  rows.forEach((row) => {
    row.scrollIntoView = vi.fn();
    row.addEventListener("click", () => store.openBrief(row.dataset.brief!));
  });
  key("j");
  key("j");
  key("Enter");
  expect(store.getState().ui.openBrief).toBe("two");
  key("e");
  expect(store.getState().ui.stagePicker).toBe(false);
  expect(store.getState().ui.openTask).toBeNull();
});

test("palette Escape works from its input and cancels a pending chord", () => {
  const { store, key } = setup();
  key("g");
  store.setPalette(true);
  const input = document.createElement("input");
  document.body.append(input);
  key("Escape", input);
  expect(store.getState().ui.palette).toBe(false);
  key("n");
  expect(store.getState().ui.view).toBe("all");
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
  key("j", button);
  expect(document.activeElement).not.toBe(button);
  key("Enter", document.activeElement!);
  expect(store.getState().ui.openTask).not.toBeNull();
});
