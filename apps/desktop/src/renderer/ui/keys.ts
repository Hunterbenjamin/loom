import { useEffect, useRef } from "react";
import { inboxRows, reasonTab } from "../store/inbox.js";
import { cursorRows } from "../store/selectors.js";
import type { Store } from "../store/store.js";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return TYPING.has(element.tagName) || element.isContentEditable;
}

/**
 * Every action in this shell is reachable from the keyboard: `cmd+k`, `g` then `i`/`b`/`n`,
 * `j`/`k`, `enter`, `esc`, `c`, `/` and `e`.
 */
export function useShortcuts(store: Store): void {
  const pendingG = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { ui } = store.getState();

      if (ui.createIssue) {
        pendingG.current = false;
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        store.setPalette(!ui.palette);
        return;
      }

      if (event.key === "Escape") {
        if (ui.palette) return store.setPalette(false);
        if (ui.stagePicker) return store.setStagePicker(false);
        if (ui.searching) return store.setSearching(false);
        if (ui.openTask) return store.open(null);
        return;
      }

      if (ui.palette || ui.stagePicker) return;
      if (typing(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (pendingG.current) {
        pendingG.current = false;
        const key = event.key.toLowerCase();
        if (key === "i") return store.setPane("list");
        if (key === "b") return store.setPane("board");
        if (key === "n") {
          store.setView("needs-you");
          return;
        }
        return;
      }

      const inbox =
        ui.view === "needs-you" ? inboxRows(store.getState()) : null;
      const rows = inbox ?? cursorRows(store.getState());
      switch (event.key) {
        case "g":
          pendingG.current = true;
          window.setTimeout(() => {
            pendingG.current = false;
          }, 900);
          return;
        case "j":
          event.preventDefault();
          return store.moveCursor(1, rows.length);
        case "k":
          event.preventDefault();
          return store.moveCursor(-1, rows.length);
        case "Enter": {
          const attention = inbox?.[ui.cursor];
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
          const row = rows[ui.cursor];
          if (row) store.open(row.task.id);
          return;
        }
        case "c":
        case "C":
          event.preventDefault();
          store.setCreateIssue(true);
          return;
        case "/":
          event.preventDefault();
          store.setSearching(true);
          return;
        case "e":
          event.preventDefault();
          store.setStagePicker(true);
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);
}
