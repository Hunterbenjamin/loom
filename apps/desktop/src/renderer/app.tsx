import { useEffect, useRef } from "react";
import { attentionCount, inboxRows } from "./store/inbox.js";
import { useStore, useStoreApi } from "./store/react.js";
import { selectedRows } from "./store/selectors.js";
import { VIEWS } from "./store/store.js";
import { BoardView } from "./ui/board.js";
import { CreateIssue } from "./ui/create-issue.js";
import { Detail } from "./ui/detail.js";
import { InboxView } from "./ui/inbox.js";
import { useShortcuts } from "./ui/keys.js";
import { LeadBar } from "./ui/lead.js";
import { ListView } from "./ui/list.js";
import { Palette, StagePicker } from "./ui/palette.js";
import { Sidebar } from "./ui/sidebar.js";

export function App() {
  const store = useStoreApi();
  useShortcuts(store);

  const theme = useStore((s) => s.ui.theme);
  const waiting = useStore(
    (s) =>
      s.live && s.connection !== "connected" && s.snapshot.tasks.length === 0,
  );
  const pane = useStore((s) => s.ui.pane);
  const view = useStore((s) => s.ui.view);
  const searching = useStore((s) => s.ui.searching);
  const query = useStore((s) => s.ui.query);
  const toast = useStore((s) => s.ui.toast);
  const count = useStore((s) =>
    s.ui.view === "needs-you" ? inboxRows(s).length : selectedRows(s).length,
  );
  const needsYou = useStore(attentionCount);
  useEffect(() => {
    document.title = `Loom · ${needsYou} need you`;
  }, [needsYou]);
  const task = useStore((s) =>
    s.ui.openTask
      ? (s.snapshot.tasks.find((t) => t.id === s.ui.openTask) ?? null)
      : null,
  );
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // One frame after the first rows are on screen: the point the window is usable.
  useEffect(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => window.loomHost.interactive()),
    );
  }, []);

  useEffect(() => {
    if (searching) search.current?.focus();
  }, [searching]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => store.toast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast, store]);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <h1>{VIEWS.find((item) => item.id === view)?.label}</h1>
          <span className="faint nums">{count}</span>
          <span className="spacer" />
          {searching ? (
            <input
              ref={search}
              className="search"
              placeholder="Search tasks"
              value={query}
              onChange={(event) => store.setQuery(event.target.value)}
              onBlur={() => {
                if (query === "") store.setSearching(false);
              }}
            />
          ) : (
            <button type="button" onClick={() => store.setSearching(true)}>
              Search <kbd>/</kbd>
            </button>
          )}
          <div className="segmented">
            <button
              type="button"
              aria-pressed={pane === "list"}
              onClick={() => store.setPane("list")}
            >
              List
            </button>
            <button
              type="button"
              aria-pressed={pane === "board"}
              onClick={() => store.setPane("board")}
            >
              Board
            </button>
          </div>
        </header>

        <div
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {waiting ? (
            <div className="pad faint">Waiting for the coordinator…</div>
          ) : view === "needs-you" ? (
            <InboxView />
          ) : pane === "list" ? (
            <ListView />
          ) : (
            <BoardView />
          )}
          {task ? <Detail task={task} /> : null}
        </div>
      </div>

      <LeadBar />
      <Palette />
      <StagePicker />
      <CreateIssue />
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
