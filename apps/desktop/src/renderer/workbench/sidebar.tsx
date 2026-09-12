import type { PaneView } from "@loom/protocol";
import { useEffect } from "react";
import { useStore } from "../store/react.js";
import { terminalAgents } from "./agents.js";
import { terminalList } from "./selectors.js";

export function Sidebar({
  filter,
  setFilter,
  choose,
  newTerminal,
  openPinned,
}: {
  filter: string;
  setFilter: (value: string) => void;
  choose: (pane: PaneView) => void;
  newTerminal: () => void;
  openPinned: (target: "main" | "operator") => void;
}) {
  const panes = useStore((s) => s.panes);
  const unavailable = useStore((s) => s.panesUnavailable);
  const snapshot = useStore((s) => s.snapshot);
  const terminals = terminalList(panes, filter);
  const lead = useStore((s) => s.lead);
  const operator = useStore((s) => s.operator);
  const agents = terminalAgents(
    panes,
    snapshot.runs,
    snapshot.questions,
    filter,
  );
  const waiting = agents.filter((a) => a.state.priority === 0).length;
  useEffect(() => {
    window.loomHost.interactive();
  }, []);
  const renderAgent = ({ run, pane, name, state }: (typeof agents)[number]) => {
    return (
      <div className="wb-agent-row" key={run.id}>
        <button
          type="button"
          className="wb-agent"
          onClick={() => choose(pane)}
          title={`${state.label} · Open terminal`}
        >
          <span
            className={`wb-status ${state.tone}`}
            role="img"
            aria-label={state.label}
          >
            {state.icon}
          </span>
          <span className="wb-agent-text">
            <strong>{name}</strong>
            <small>
              {run.role} · {run.provider}
            </small>
            <span className={`wb-state-label ${state.tone}`}>
              {state.label}
            </span>
          </span>
        </button>
      </div>
    );
  };
  return (
    <aside className="wb-sidebar" aria-label="Terminals and agents">
      <input
        id="agent-filter"
        aria-label="Find terminal or agent"
        placeholder="Find terminal or agent…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <section className="wb-terminals" aria-label="Terminal tree">
        <div className="wb-section-heading">
          <h2>Terminals</h2>
          <button type="button" aria-label="New terminal" onClick={newTerminal}>
            ＋
          </button>
        </div>
        {unavailable && (
          <p role="status">
            Terminal host unavailable. Showing last known terminals.
          </p>
        )}
        <section className="wb-pinned" aria-label="Pinned terminals">
          <button
            type="button"
            className="wb-tree-pane"
            onClick={() => openPinned("main")}
            title="Open Main terminal"
          >
            <span aria-hidden="true">⌁</span>
            <span>Main</span>
            <small>{lead.status}</small>
          </button>
          <button
            type="button"
            className="wb-tree-pane"
            onClick={() => openPinned("operator")}
            title="Open Operator terminal"
          >
            <span aria-hidden="true">⌁</span>
            <span>Operator</span>
            <small>{operator?.status ?? "Connecting"}</small>
          </button>
        </section>
        <div className="wb-terminal-list">
          {terminals.map(({ pane, name }) => (
            <button
              type="button"
              key={pane.id}
              className="wb-tree-pane"
              disabled={unavailable || pane.unavailable}
              onClick={() => choose(pane)}
              title={`${pane.startCwd}\n${pane.command}`}
            >
              <span aria-hidden="true">⌁</span>
              <span>{name}</span>
            </button>
          ))}
          {!terminals.length && filter && (
            <p className="wb-muted">No matching terminals</p>
          )}
        </div>
      </section>
      <section className="wb-agents" aria-label="Agents">
        <div className="wb-section-heading">
          <h2>
            Agents <span>{agents.length}</span>
          </h2>
          {waiting > 0 && (
            <span className="wb-waiting-count" role="status">
              {waiting} need you
            </span>
          )}
        </div>
        {!agents.length && (
          <p className="wb-muted">
            {filter ? "No matching agents" : "No running agent terminals"}
          </p>
        )}
        {agents.map(renderAgent)}
      </section>
    </aside>
  );
}
