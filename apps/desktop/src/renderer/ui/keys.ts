import { useEffect, useState } from "react";
import { selectedDetailTask } from "../store/detail-selection.js";
import { inboxRows, reasonTab } from "../store/inbox.js";
import { selectedPullRequests } from "../store/pull-requests.js";
import { cursorItems, selectedRows } from "../store/selectors.js";
import type { Store } from "../store/store.js";
import { STAGES } from "./format.js";
import { typingScrollCommand } from "./scroll-keys.js";
import { hasTrackerAction, runTrackerAction } from "./tracker-actions.js";
import {
  eventKey,
  type TrackerActionId,
  trackerKeymap,
} from "./tracker-keymap.js";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const element = target as HTMLElement;
  return (
    TYPING.has(element.tagName) ||
    element.isContentEditable ||
    !!element.closest(
      ".xterm, .chat-window, [contenteditable]:not([contenteditable=false])",
    )
  );
}

/** The `commands` binding in the Tracker: opens the command palette, or closes it. */
export function togglePalette(store: Store) {
  store.setPalette(!store.getState().ui.palette);
}

export function runTrackerCommand(
  store: Store,
  id: TrackerActionId,
  showHelp: () => void = () => {},
) {
  const state = store.getState();
  const { ui } = state;
  if (id.startsWith("go-")) {
    const view = id.slice(3) as typeof ui.view;
    store.setView(view);
    return;
  }
  if (id === "help") return showHelp();
  if (id === "create") return store.setCreatePalette(true);
  if (id === "close") {
    if (ui.createPalette) return store.setCreatePalette(false);
    if (ui.palette) return store.setPalette(false);
    if (ui.stagePicker) return store.setStagePicker(false);
    if (ui.openPr) return store.openPullRequest(null);
    if (ui.openResearch) return store.openResearch(null);
    if (ui.openBrief) return store.openBrief(null);
    return store.open(null);
  }
  if (id === "stage") return store.setStagePicker(true);
  if (id === "view") {
    if (ui.view === "all" || ui.view === "needs-you")
      store.setPane(ui.pane === "list" ? "board" : "list");
    return;
  }
  if (runTrackerAction(store, id)) return;
  if (id === "next-issue" || id === "previous-issue") {
    const direction = id === "next-issue" ? 1 : -1;
    if (ui.openPr) {
      const rows = selectedPullRequests(state);
      const index = rows.findIndex(
        (row) =>
          row.repoId === ui.openPr?.repoId && row.number === ui.openPr.number,
      );
      const row = rows[index + direction];
      if (index >= 0 && row)
        store.openPullRequest({ repoId: row.repoId, number: row.number });
    } else {
      const rows =
        ui.view === "needs-you" && ui.pane === "list"
          ? inboxRows(state)
          : cursorItems(state).flatMap((item) =>
              item.kind === "row" ? [item.row] : [],
            );
      const unique = rows.filter(
        (row, index) =>
          rows.findIndex((other) => other.task.id === row.task.id) === index,
      );
      const index = unique.findIndex((row) => row.task.id === ui.openTask);
      const row = unique[index + direction];
      if (index >= 0 && row) {
        const tab = ui.tab;
        store.open(row.task.id);
        store.setTab(tab);
      }
    }
    return;
  }
  if (
    ui.openTask ||
    ui.openPr ||
    ui.openBrief ||
    ui.openResearch ||
    ui.view === "settings" ||
    ui.view === "research" ||
    ui.view === "briefs"
  )
    return;
  const inbox =
    ui.view === "needs-you" && ui.pane === "list" ? inboxRows(state) : null;
  const review = ui.view === "pull-requests";
  const rows = review
    ? selectedPullRequests(state)
    : (inbox ?? cursorItems(state));
  const cursor = review ? ui.prCursor : ui.cursor;
  const setCursor = review ? store.setPrCursor : store.setCursor;
  const board = ui.pane === "board" && !review && !inbox;
  const items = cursorItems(state);
  const issueList = !board && !review && !inbox;
  if (issueList && (id === "next-section" || id === "previous-section")) {
    const headers = items.flatMap((item, index) =>
      item.kind === "header" ? [index] : [],
    );
    const next =
      id === "next-section"
        ? headers.find((index) => index > (cursor ?? -1))
        : headers.findLast((index) => index < (cursor ?? items.length));
    if (next !== undefined) store.setCursor(next);
    return;
  }
  if (issueList && id === "collapse-section") {
    const item = items[cursor ?? -1];
    if (!item) return;
    const stage = item.kind === "row" ? item.row.task.stage : item.stage;
    const header = items.findIndex(
      (item) => item.kind === "header" && item.stage === stage,
    );
    store.setCursor(header);
    const entry = items[header];
    // One key both ways: from a row the section is open, so this collapses it; on a collapsed
    // header it expands again, so h never becomes a no-op the human has to follow with l.
    if (entry?.kind === "header") store.toggleListSection(stage);
    return;
  }
  if (id === "open" || (id === "expand-item" && issueList)) {
    if (review) {
      const pr = selectedPullRequests(state)[cursor ?? -1];
      if (pr) store.openPullRequest({ repoId: pr.repoId, number: pr.number });
    } else {
      const attention = inbox?.[cursor ?? -1];
      if (attention) {
        const run = attention.runs[0] ?? null;
        store.openAttention(
          attention.task.id,
          attention.reason,
          reasonTab(attention.reason, run),
          run?.id ?? null,
        );
      } else {
        const item = items[cursor ?? -1];
        if (item?.kind === "row") store.open(item.row.task.id);
        else if (item?.kind === "header" && item.collapsed)
          store.toggleListSection(item.stage);
        else if (item?.kind === "load-more") {
          // Inserting the page at this stop makes its index the first newly revealed row.
          store.loadMoreListSection(item.stage);
          store.setCursor(cursor);
        }
      }
    }
    return;
  }
  if (board) {
    if (
      [
        "next-row",
        "previous-row",
        "left-column",
        "right-column",
        "first-row",
        "last-row",
      ].includes(id)
    )
      setCursor(boardCursor(selectedRows(state), cursor, id));
  } else if (
    ["next-row", "previous-row", "first-row", "last-row"].includes(id)
  ) {
    setCursor(
      !rows.length
        ? null
        : id === "first-row"
          ? 0
          : id === "last-row"
            ? rows.length - 1
            : cursor === null
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    cursor + (id === "next-row" ? 1 : -1),
                  ),
                ),
    );
  }
}

/** A single listener resolves scope before dispatch, independent of React effect order. */
export function createShortcutHandler(
  store: Store,
  showHelp: () => void = () => {},
  onPending: (pending: boolean) => void = () => {},
) {
  let pending = false;
  const setPending = (value: boolean) => {
    pending = value;
    onPending(value);
  };
  const handler = (event: KeyboardEvent) => {
    const { ui } = store.getState();
    if (
      event.defaultPrevented ||
      event.isComposing ||
      document.querySelector("dialog[open]") ||
      ui.create
    ) {
      setPending(false);
      return;
    }
    const target = event.composedPath()[0] ?? event.target;
    const ownsKeys =
      target instanceof Element && target.closest(".xterm, .chat-window");
    if (ownsKeys || (typing(target) && !typingScrollCommand(event))) {
      setPending(false);
      return;
    }
    const key = eventKey(event);
    if (pending && key === "Escape") {
      setPending(false);
      event.preventDefault();
      return;
    }
    if (ui.createPalette || ui.palette || ui.stagePicker) {
      setPending(false);
      if (key === "Escape") {
        event.preventDefault();
        runTrackerCommand(store, "close");
      }
      return;
    }
    let sequence = key;
    if (pending) {
      sequence = `g ${key}`;
      setPending(false);
      event.preventDefault();
    } else if (key === "g") {
      setPending(true);
      event.preventDefault();
      return;
    }
    const detail = !!(
      ui.openTask ||
      ui.openPr ||
      ui.openBrief ||
      ui.openResearch
    );
    const issue = detail
      ? !!selectedDetailTask(store.getState())
      : !["pull-requests", "briefs", "research", "settings"].includes(ui.view);
    const candidates = trackerKeymap.filter((entry) =>
      (entry.keys as readonly string[]).includes(sequence),
    );
    // Registered diff actions own these keys even when no file/hunk is available.
    const diff = candidates.find((entry) => entry.scope === "diff");
    if (detail && diff && hasTrackerAction(store, diff.id)) {
      event.preventDefault();
      if (!event.repeat) runTrackerAction(store, diff.id);
      return;
    }
    const entry = candidates.find(
      (entry) =>
        entry.scope === "global" ||
        (entry.scope === "detail" && detail) ||
        (entry.scope === "issue" && issue) ||
        (entry.scope === "list" && !detail && ui.view !== "settings") ||
        (entry.scope === "board" && !detail && ui.pane === "board" && issue) ||
        (entry.scope === "issue-list" &&
          !detail &&
          ui.pane === "list" &&
          issue &&
          ui.view !== "needs-you"),
    );
    if (!entry) return;
    if (
      entry.id === "open" &&
      event.target instanceof Element &&
      event.target.closest("button, a, summary")
    )
      return;
    event.preventDefault();
    const repeatable = [
      "next-row",
      "previous-row",
      "left-column",
      "right-column",
      "scroll-down",
      "scroll-up",
      "half-page-down",
      "half-page-up",
      "page-down",
      "page-up",
    ];
    if (event.repeat && !repeatable.includes(entry.id)) return;
    if (
      !detail &&
      (repeatable.includes(entry.id) ||
        entry.id === "next-section" ||
        entry.id === "previous-section" ||
        entry.id === "collapse-section" ||
        entry.id === "first-row" ||
        entry.id === "last-row") &&
      event.target instanceof HTMLElement
    )
      event.target.blur();
    runTrackerCommand(store, entry.id, showHelp);
  };
  return Object.assign(handler, { cancel: () => setPending(false) });
}
const noHelp = () => {};
export function useShortcuts(
  store: Store,
  showHelp: () => void = noHelp,
): boolean {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const handler = createShortcutHandler(store, showHelp, setPending);
    window.addEventListener("keydown", handler);
    const cancel = handler.cancel;
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerdown", cancel);
    window.addEventListener("focusin", cancel);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("focusin", cancel);
    };
  }, [store, showHelp]);
  return pending;
}

/** Board cursor indices use the same rows as the cards and stage picker. */
export function boardCursor(
  rows: ReturnType<typeof selectedRows>,
  cursor: number | null,
  action: TrackerActionId,
): number | null {
  const columns = STAGES.map((stage) =>
    rows
      .map((row, index) => ({ row, index }))
      .filter((item) => item.row.task.stage === stage),
  ).filter((column) => column.length);
  if (!columns.length) return null;
  const columnIndex = columns.findIndex((column) =>
    column.some((item) => item.index === cursor),
  );
  if (columnIndex < 0) {
    const first = columns[0];
    return (action === "last-row" ? first?.at(-1) : first?.[0])?.index ?? null;
  }
  const column = columns[columnIndex]!;
  if (action === "first-row") return column[0]!.index;
  if (action === "last-row") return column[column.length - 1]!.index;
  const rowIndex = column.findIndex((item) => item.index === cursor);
  if (action === "next-row" || action === "previous-row")
    return column[
      Math.max(
        0,
        Math.min(
          column.length - 1,
          rowIndex + (action === "next-row" ? 1 : -1),
        ),
      )
    ]!.index;
  const next =
    columns[
      Math.max(
        0,
        Math.min(
          columns.length - 1,
          columnIndex + (action === "right-column" ? 1 : -1),
        ),
      )
    ]!;
  return next[Math.min(rowIndex, next.length - 1)]!.index;
}
