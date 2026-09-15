import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { attentionCount, inboxRows } from "./store/inbox.js";
import { selectedPullRequests } from "./store/pull-requests.js";
import { useStore, useStoreApi } from "./store/react.js";
import { selectedRows } from "./store/selectors.js";
import { VIEWS } from "./store/ui-state.js";
import { BoardView } from "./ui/board.js";
import { BriefsView } from "./ui/briefs.js";
import { CreateIssue } from "./ui/create-issue.js";
import { Detail } from "./ui/detail.js";
import { InboxView } from "./ui/inbox.js";
import { useShortcuts } from "./ui/keys.js";
import { LeadBar } from "./ui/lead.js";
import { ListView } from "./ui/list.js";
import { TrackerFilter } from "./ui/list-rows.js";
import { Palette, StagePicker } from "./ui/palette.js";
import { PullRequestsView } from "./ui/pull-requests.js";
import { SettingsView } from "./ui/settings.js";
import { OpenRepository, Sidebar } from "./ui/sidebar.js";
import { TrackerHelp, WhichKey } from "./ui/tracker-help.js";
import { keyHint } from "./ui/tracker-keymap.js";

const PullRequestDetail = lazy(() =>
  import("./ui/pull-request-detail.js").then((m) => ({
    default: m.PullRequestDetail,
  })),
);

export function App() {
  const store = useStoreApi();
  const [help, setHelp] = useState(false);
  const showHelp = useCallback(() => setHelp(true), []);
  const pendingKey = useShortcuts(store, showHelp);
  useEffect(() => {
    store.setTrackerVisible(true);
    return () => store.setTrackerVisible(false);
  }, [store]);

  const repo = useStore((s) => s.ui.repo);
  const theme = useStore((s) => s.ui.theme);
  const appearance = useStore(
    (s) =>
      (
        s.settings.find((item) => item.id === `repo:${s.ui.repo}`) ??
        s.settings.find((item) => item.id === "global")
      )?.effective.appearance,
  );
  useEffect(() => {
    if (!appearance) return;
    const configured =
      appearance.theme === "system"
        ? window.matchMedia?.("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : appearance.theme;
    store.setTheme(configured);
    store.setChimeMuted(!appearance.chime);
  }, [appearance, store]);
  const waiting = useStore(
    (s) =>
      s.connection !== "connected" &&
      (s.ui.view === "pull-requests"
        ? s.snapshot.pullRequests.length === 0
        : s.snapshot.tasks.length === 0),
  );
  const pane = useStore((s) => s.ui.pane);
  const view = useStore((s) => s.ui.view);
  const toast = useStore((s) => s.ui.toast);
  const count = useStore((s) =>
    s.ui.view === "settings"
      ? s.settings.length
      : s.ui.view === "pull-requests"
        ? selectedPullRequests(s).length
        : s.ui.view === "needs-you"
          ? inboxRows(s).length
          : selectedRows(s).length,
  );
  const needsYou = useStore(attentionCount);
  useEffect(() => {
    document.title = `Loom · ${needsYou} need you`;
  }, [needsYou]);
  const task = useStore((s) =>
    s.ui.openTask
      ? (s.snapshot.tasks.find(
          (t) => t.id === s.ui.openTask && t.repoId === s.ui.repo,
        ) ?? null)
      : null,
  );
  const openPr = useStore((s) => s.ui.openPr);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Measure first data paint, including the coordinator snapshot on a cold start.
  useEffect(() => {
    if (waiting) return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => window.loomHost.interactive()),
    );
    return () => cancelAnimationFrame(frame);
  }, [waiting]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => store.toast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast, store]);

  return (
    <div className="shell">
      {help ? <TrackerHelp onClose={() => setHelp(false)} /> : null}
      {pendingKey ? <WhichKey /> : null}
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <h1>
            {view === "briefs"
              ? "Daily brief"
              : view === "settings"
                ? "Settings"
                : view === "pull-requests"
                  ? "Reviews"
                  : VIEWS.find((item) => item.id === view)?.label}
          </h1>
          {view === "pull-requests" ||
          view === "settings" ||
          view === "briefs" ? null : (
            <span className="faint nums">{count}</span>
          )}
          <span className="spacer" />
          <button
            type="button"
            onClick={showHelp}
            {...keyHint("help")}
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          {view !== "pull-requests" &&
            view !== "settings" &&
            view !== "briefs" && (
              <div className="segmented">
                <button
                  type="button"
                  {...keyHint("view")}
                  aria-pressed={pane === "list"}
                  onClick={() => store.setPane("list")}
                >
                  List
                </button>
                <button
                  type="button"
                  {...keyHint("view")}
                  aria-pressed={pane === "board"}
                  onClick={() => store.setPane("board")}
                >
                  Board
                </button>
              </div>
            )}
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
          {view !== "settings" && view !== "pull-requests" ? (
            <TrackerFilter />
          ) : null}
          {view === "briefs" ? (
            <BriefsView />
          ) : view === "settings" ? (
            <SettingsView />
          ) : waiting ? (
            <div className="pad faint">Waiting for the coordinator…</div>
          ) : !repo ? (
            <OpenRepository />
          ) : view === "pull-requests" ? (
            <PullRequestsView />
          ) : view === "needs-you" && pane === "list" ? (
            <InboxView />
          ) : pane === "list" ? (
            <ListView />
          ) : (
            <BoardView />
          )}
          {openPr ? (
            <Suspense
              fallback={<div className="detail pad">Loading pull request…</div>}
            >
              <PullRequestDetail
                key={`${openPr.repoId}:${openPr.number}`}
                selection={openPr}
              />
            </Suspense>
          ) : task ? (
            <Detail key={task.id} task={task} />
          ) : null}
        </div>
      </div>

      <LeadBar surface="tracker" />
      <Palette />
      <StagePicker />
      <CreateIssue />
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
