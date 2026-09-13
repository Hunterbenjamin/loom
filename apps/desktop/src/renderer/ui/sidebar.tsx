import { useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { viewCounts } from "../store/selectors.js";
import { VIEWS } from "../store/store.js";

export function Sidebar() {
  const store = useStoreApi();
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
  const counts = useStore((s) => viewCounts(s.snapshot, s.ui.repo));

  return (
    <nav className="sidebar" aria-label="Views">
      <div className="sidebar-top">
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
        <button
          type="button"
          className="create-issue-button"
          disabled={!repo}
          aria-label="Create issue"
          title="Create issue (C)"
          onClick={() => store.setCreateIssue(true)}
        >
          +
        </button>
      </div>

      {error ? (
        <div className="pad" role="alert">
          {error}
        </div>
      ) : null}
      <div className="sidebar-section">Views</div>
      {VIEWS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="view-item"
          aria-current={view === item.id ? "page" : undefined}
          title={item.hint}
          data-view={item.id}
          onClick={() => store.setView(item.id)}
        >
          <span>{item.label}</span>
          <span className="count">
            {item.id === "needs-you" ? needsYou : counts[item.id]}
          </span>
        </button>
      ))}

      <button
        type="button"
        className="view-item"
        data-view="pull-requests"
        aria-current={view === "pull-requests" ? "page" : undefined}
        onClick={() => store.setView("pull-requests")}
      >
        <span>Pull requests</span>
        <span className="count">{counts["pull-requests"]}</span>
      </button>

      <div className="pad faint" role="status">
        {connection === "connected"
          ? ""
          : connection === "fixtures"
            ? "Fixture mode"
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
        <kbd>⌘K</kbd>
      </div>
    </nav>
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
