import { useEffect } from "react";
import { selectedDetailTask } from "../store/detail-selection.js";
import { inboxRows, reasonTab } from "../store/inbox.js";
import { selectedPullRequests } from "../store/pull-requests.js";
import { cursorRows, selectedRows } from "../store/selectors.js";
import type { Store } from "../store/store.js";
import { STAGES } from "./format.js";
import {
  pullRequestShortcut,
  requestPullRequestAction,
} from "./pull-request-commands.js";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const element = target as HTMLElement;
  return (
    TYPING.has(element.tagName) ||
    element.isContentEditable ||
    !!element.closest(".xterm, [contenteditable]:not([contenteditable=false])")
  );
}

/** Routes shortcuts to the active surface; text editing and modal dialogs own their keys. */
export function createShortcutHandler(
  store: Store,
  showHelp: () => void = () => {},
) {
  let pendingUntil = 0;
  const onKeyDown = (event: KeyboardEvent) => {
    const { ui } = store.getState();
    if (
      event.defaultPrevented ||
      event.isComposing ||
      document.querySelector("dialog[open]") ||
      ui.createIssue
    ) {
      pendingUntil = 0;
      return;
    }
    if (typing(event.target)) {
      pendingUntil = 0;
      if (event.key === "Escape" && (ui.palette || ui.stagePicker)) {
        store.setPalette(false);
        store.setStagePicker(false);
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      store.setPalette(!ui.palette);
      return;
    }

    if (event.key === "Escape") {
      pendingUntil = 0;
      if (ui.palette) return store.setPalette(false);
      if (ui.stagePicker) return store.setStagePicker(false);
      if (ui.openPr) return store.openPullRequest(null);
      if (ui.openBrief) return store.openBrief(null);
      if (ui.openTask) return store.open(null);
      return;
    }

    if (ui.palette || ui.stagePicker) {
      pendingUntil = 0;
      return;
    }
    if (
      ui.openPr &&
      event.metaKey &&
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.repeat
    ) {
      pendingUntil = 0;
      event.preventDefault();
      requestPullRequestAction({ ...ui.openPr, action: "merge" });
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      pendingUntil = 0;
      return;
    }

    if (pendingUntil > Date.now()) {
      pendingUntil = 0;
      event.preventDefault();
      if (event.key === "g" && (ui.openTask || ui.openPr || ui.openBrief)) {
        const body = document.querySelector<HTMLElement>(
          ".detail .pr-page-body",
        );
        if (body) body.scrollTop = 0;
        return;
      }
      if (event.key === "i") return store.setPane("list");
      if (event.key === "b") return store.setPane("board");
      const views = {
        a: "all",
        n: "needs-you",
        r: "pull-requests",
        d: "briefs",
        s: "settings",
      } as const;
      const view = views[event.key as keyof typeof views];
      if (view) store.setView(view);
      return;
    }
    if (event.key === "g") {
      pendingUntil = Date.now() + 900;
      return;
    }
    if (event.key === "?") {
      event.preventDefault();
      showHelp();
      return;
    }
    if (event.key === "c" || event.key === "C") {
      event.preventDefault();
      if (!event.repeat) store.setCreateIssue(true);
      return;
    }
    // Native activation must keep working for controls reached with Tab.
    if (
      event.key === "Enter" &&
      event.target instanceof Element &&
      event.target.closest("button, a, summary")
    )
      return;

    if (ui.openTask || ui.openPr || ui.openBrief) {
      const detail = document.querySelector<HTMLElement>(".detail");
      const click = (selector: string) => {
        if (!event.repeat)
          detail?.querySelector<HTMLElement>(selector)?.click();
        event.preventDefault();
      };
      const tabs = ["overview", "plan", "diff", "terminal"];
      const tab = tabs[Number(event.key) - 1];
      if (tab) return click(`[data-tab="${tab}"]`);
      const actions: Record<string, string> = {
        a: '[data-issue-action="approve-plan"], [data-issue-action="approve-merge"]',
        A: '[data-issue-action="change-plan"], [data-issue-action="request-changes"]',
        E: '[data-issue-action="edit"]',
        t: '[data-issue-action="todo"]',
        z: ".activity-more",
        f: ".overview-findings > summary",
        F: "[data-detail-fullscreen]",
      };
      if (actions[event.key]) return click(actions[event.key]);
      if (["j", "k", "J", "K", "G"].includes(event.key)) {
        event.preventDefault();
        const body = detail?.querySelector<HTMLElement>(".pr-page-body");
        if (body)
          body.scrollTop =
            event.key === "G"
              ? body.scrollHeight
              : body.scrollTop +
                (event.key.toLowerCase() === "j" ? 1 : -1) *
                  (event.shiftKey ? body.clientHeight / 2 : 60);
        return;
      }
      if (event.key === "e" && selectedDetailTask(store.getState())) {
        event.preventDefault();
        store.setStagePicker(true);
        return;
      }
      if (ui.openPr) {
        const action = pullRequestShortcut(event.key);
        if (action && !event.repeat) {
          event.preventDefault();
          requestPullRequestAction({ ...ui.openPr, action });
        }
      }
      return;
    }
    if (ui.view === "settings") return;
    // Roving row navigation leaves a previously tabbed control. Otherwise Enter
    // would activate that old control instead of opening the newly selected row.
    if (
      (event.key === "j" ||
        event.key === "k" ||
        (ui.pane === "board" &&
          ui.view !== "needs-you" &&
          ui.view !== "pull-requests" &&
          ui.view !== "briefs" &&
          (event.key === "h" || event.key === "l"))) &&
      event.target instanceof HTMLElement
    )
      event.target.blur();
    if (ui.view === "briefs") {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-brief]")];
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        store.moveCursor(event.key === "j" ? 1 : -1, rows.length);
        rows[store.getState().ui.cursor ?? 0]?.scrollIntoView({
          block: "nearest",
        });
      }
      if (event.key === "Enter") {
        event.preventDefault();
        rows[ui.cursor ?? -1]?.click();
      }
      return;
    }
    if (
      ui.pane === "board" &&
      ui.view !== "needs-you" &&
      ui.view !== "pull-requests" &&
      ["h", "j", "k", "l"].includes(event.key)
    ) {
      event.preventDefault();
      store.setCursor(
        boardCursor(selectedRows(store.getState()), ui.cursor, event.key),
      );
      return;
    }

    if (ui.view === "pull-requests" && !ui.openTask) {
      const rows = selectedPullRequests(store.getState());
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        if (rows.length === 0) return;
        store.setPrCursor(
          ui.prCursor === null
            ? 0
            : Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  ui.prCursor + (event.key === "j" ? 1 : -1),
                ),
              ),
        );
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-pr-search]")?.focus();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const pr = ui.prCursor === null ? undefined : rows[ui.prCursor];
        if (pr) store.openPullRequest({ repoId: pr.repoId, number: pr.number });
        return;
      }
      // Task stage actions do not apply to repository PRs.
      if (event.key === "e") return;
    }

    const inbox = ui.view === "needs-you" ? inboxRows(store.getState()) : null;
    const rows = inbox ?? cursorRows(store.getState());
    switch (event.key) {
      case "j":
        event.preventDefault();
        return store.moveCursor(1, rows.length);
      case "k":
        event.preventDefault();
        return store.moveCursor(-1, rows.length);
      case "Enter": {
        event.preventDefault();
        const attention = ui.cursor === null ? undefined : inbox?.[ui.cursor];
        if (attention) {
          const run = attention.runs[0] ?? null;
          store.openAttention(
            attention.task.id,
            attention.reason,
            reasonTab(attention.reason, run),
            run?.id ?? null,
          );
          return;
        }
        const row = ui.cursor === null ? undefined : rows[ui.cursor];
        if (row) store.open(row.task.id);
        return;
      }
      case "e":
        event.preventDefault();
        store.setStagePicker(true);
        return;
      default:
        return;
    }
  };

  return onKeyDown;
}

const noHelp = () => {};

export function useShortcuts(
  store: Store,
  showHelp: () => void = noHelp,
): void {
  useEffect(() => {
    const handler = createShortcutHandler(store, showHelp);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [store, showHelp]);
}

/** Board cursor indices use the same rows as the cards and stage picker. */
export function boardCursor(
  rows: ReturnType<typeof selectedRows>,
  cursor: number | null,
  key: string,
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
  if (columnIndex < 0) return columns[0]?.[0]?.index ?? null;
  const column = columns[columnIndex]!;
  const rowIndex = column.findIndex((item) => item.index === cursor);
  if (key === "j" || key === "k")
    return column[
      Math.max(
        0,
        Math.min(column.length - 1, rowIndex + (key === "j" ? 1 : -1)),
      )
    ]!.index;
  const next =
    columns[
      Math.max(
        0,
        Math.min(columns.length - 1, columnIndex + (key === "l" ? 1 : -1)),
      )
    ]!;
  return next[Math.min(rowIndex, next.length - 1)]!.index;
}
