import { useStore, useStoreApi } from "../store/react.js";
import { viewCounts } from "../store/selectors.js";
import { VIEWS } from "../store/store.js";

export function Sidebar() {
  const store = useStoreApi();
  const connection = useStore((s) => s.connection);
  const needsYou = useStore((s) =>
    s.snapshot.tasks
      .filter((t) => s.ui.repo === "all" || t.repoId === s.ui.repo)
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
          onChange={(event) => store.setRepo(event.target.value)}
        >
          <option value="all">All repositories</option>
          {repos.map((item) => (
            <option key={item.id} value={item.id}>
              {item.github}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="create-issue-button"
          aria-label="Create issue"
          title="Create issue (C)"
          onClick={() => store.setCreateIssue(true)}
        >
          +
        </button>
      </div>

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
