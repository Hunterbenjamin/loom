import { useState } from "react";
import { formatBindings } from "../../shared/keybindings.js";
import { useKeybindingsConfig } from "../keybindings-context.js";
import { reviewNeedsHuman } from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import { viewCounts } from "../store/selectors.js";
import { VIEWS } from "../store/ui-state.js";
import { keyHint } from "./tracker-keymap.js";

export function Sidebar() {
  const store = useStoreApi();
  const keybindings = useKeybindingsConfig();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const choose = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      if (value === "__add__") await store.addRepo();
      else await store.setRepo(value);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not open repository",
      );
    } finally {
      setBusy(false);
    }
  };
  const instance = useStore((s) => s.instance);
  const connection = useStore((s) => s.connection);
  const needsYou = useStore((s) =>
    s.snapshot.tasks
      .filter((t) => t.repoId === s.ui.repo)
      .reduce((n, t) => n + t.attention.reasons.length, 0),
  );
  const repos = useStore((s) => s.snapshot.repos);
  const repo = useStore((s) => s.ui.repo);
  const view = useStore((s) => s.ui.view);
  const theme = useStore((s) => s.ui.theme);
  const reviewCount = useStore(
    (s) =>
      s.snapshot.pullRequests.filter(
        (pr) => pr.repoId === s.ui.repo && reviewNeedsHuman(pr),
      ).length,
  );
  const counts = useStore((s) => viewCounts(s.snapshot, s.ui.repo));

  return (
    <nav className="sidebar" aria-label="Views">
      <div className="sidebar-top">
        <span className="instance-badge">{instance}</span>
        <div className="repo-picker">
          <select
            className="repo-select"
            aria-label="Repository"
            value={repo}
            disabled={busy}
            onChange={(event) => void choose(event.target.value)}
          >
            {!repo ? (
              <option value="" disabled>
                Open repository
              </option>
            ) : null}
            {repos.map((item) => (
              <option key={item.id} value={item.id}>
                {item.github}
              </option>
            ))}
            <option value="__add__">Add repository…</option>
          </select>
          <svg
            className="repo-chevron"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </div>
      </div>

      {error ? (
        <div className="pad" role="alert">
          {error}
        </div>
      ) : null}
      <div className="sidebar-views">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="view-item"
            aria-current={view === item.id ? "page" : undefined}
            {...keyHint(`go-${item.id}`, item.hint, keybindings)}
            data-view={item.id}
            onClick={() => store.setView(item.id)}
          >
            <ViewIcon view={item.id} />
            <span>{item.label}</span>
            <span className="count">
              {item.id === "needs-you"
                ? needsYou
                : item.id === "pull-requests"
                  ? reviewCount
                  : item.id === "all"
                    ? // Issues counts what is still open: done and canceled issues are finished.
                      counts.all - counts.done
                    : counts[item.id]}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="view-item"
          {...keyHint("go-briefs", undefined, keybindings)}
          data-view="briefs"
          aria-current={view === "briefs" ? "page" : undefined}
          onClick={() => store.setView("briefs")}
        >
          <ViewIcon view="briefs" />
          <span>Daily brief</span>
        </button>
        <button
          type="button"
          className="view-item"
          {...keyHint("go-research", undefined, keybindings)}
          data-view="research"
          aria-current={view === "research" ? "page" : undefined}
          onClick={() => store.setView("research")}
        >
          <ViewIcon view="research" />
          <span>Research</span>
        </button>
        <button
          type="button"
          className="view-item"
          data-view="settings"
          aria-current={view === "settings" ? "page" : undefined}
          {...keyHint("go-settings", undefined, keybindings)}
          onClick={() => store.setView("settings")}
        >
          <ViewIcon view="settings" />
          <span>Settings</span>
        </button>
      </div>

      <div className="pad faint" role="status">
        {connection === "connected"
          ? ""
          : connection === "disconnected"
            ? "Disconnected"
            : connection === "connecting"
              ? "Connecting…"
              : `Disconnected · ${connection}`}
      </div>
      <div className="sidebar-foot">
        <button type="button" onClick={() => store.toggleTheme()}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        <span className="spacer" />
        <kbd>{formatBindings(keybindings, "commands")}</kbd>
      </div>
    </nav>
  );
}

/** Line icons in the style of Linear's sidebar: a tray, a circled check, a pull request. */
function ViewIcon({ view }: { view: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "view-icon",
  };
  if (view === "needs-you")
    return (
      <svg {...common} aria-hidden="true">
        <path d="M2.5 9.5V4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5" />
        <path d="M2.5 9.5h3.2l.8 1.6h3l.8-1.6h3.2v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      </svg>
    );
  if (view === "pull-requests")
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="4.5" cy="3.5" r="1.5" />
        <circle cx="4.5" cy="12.5" r="1.5" />
        <circle cx="11.5" cy="12.5" r="1.5" />
        <path d="M4.5 5v6" />
        <path d="M8.5 3.5h1.5a1.5 1.5 0 0 1 1.5 1.5v6" />
        <path d="M10 2l-1.5 1.5L10 5" />
      </svg>
    );
  if (view === "briefs")
    return (
      <svg {...common} aria-hidden="true">
        <rect x="2.5" y="2" width="11" height="12" rx="1.5" />
        <path d="M5 5h6M5 8h6M5 11h3" />
      </svg>
    );
  if (view === "research")
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="6.75" cy="6.75" r="4.25" />
        <path d="m10 10 3.5 3.5" />
      </svg>
    );
  if (view === "settings")
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 2.5v1.6M8 11.9v1.6M2.5 8h1.6M11.9 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1" />
      </svg>
    );
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
    </svg>
  );
}

export function OpenRepository() {
  const store = useStoreApi();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="pad">
      <h2>Open repository</h2>
      <p>Choose a project folder to get started.</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await store.addRepo();
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "Could not open repository",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Open repository…
      </button>
      {error ? <div role="alert">{error}</div> : null}
    </div>
  );
}
