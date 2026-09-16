import type {
  Command,
  ResearchEntry,
  ResearchState,
  ResearchSummary,
} from "@loom/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { DetailLayout } from "./detail-layout.js";
import { ListGroupHeader, ListRow } from "./list-rows.js";
import { PrMarkdown } from "./pull-request-overview.js";
import { useTrackerActions } from "./tracker-actions.js";

export function ResearchView() {
  const store = useStoreApi();
  const connected = useStore((s) => s.connection === "connected");
  const open = useStore((s) => s.ui.openResearch);
  const cursor = useStore((s) => s.ui.cursor);
  const query = useStore((s) => s.ui.filterQuery);
  const [state, setState] = useState<ResearchState | null>(null);
  const [entry, setEntry] = useState<ResearchEntry | null>(null);
  const [question, setQuestion] = useState("");
  const [directory, setDirectory] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshResearch = useRef<(() => Promise<void>) | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await store.command({ kind: "list_research", archived });
        if (!result.ok) throw new Error(result.error.message);
        if (!disposed && result.result.kind === "research_list")
          setState(result.result.state);
        if (open) {
          const detail = await store.command({
            kind: "read_research",
            id: open,
          });
          if (!detail.ok) throw new Error(detail.error.message);
          if (!disposed && detail.result.kind === "research_entry")
            setEntry(detail.result.entry);
        }
        if (!disposed) setError("");
      } catch (error) {
        if (!disposed)
          setError(
            error instanceof Error ? error.message : "Could not load research",
          );
      } finally {
        loading = false;
      }
    };
    refreshResearch.current = refresh;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      refreshResearch.current = null;
      clearInterval(timer);
    };
  }, [store, connected, archived, open]);
  const act = async (command: Command) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const result = await store.command(command);
      if (!result.ok) throw new Error(result.error.message);
      if (result.result.kind === "research_entry") {
        setEntry(result.result.entry);
        if (command.kind === "start_research") {
          setQuestion("");
          store.openResearch(result.result.entry.id);
        }
      }
      await refreshResearch.current?.();
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action failed");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const rows = (state?.entries ?? []).filter((row) =>
    `${row.title ?? row.question} ${row.status}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const select = (index: number) =>
    store.setCursor(
      rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : null,
    );
  useTrackerActions({
    "next-row": () => select(cursor === null ? 0 : cursor + 1),
    "previous-row": () => select(cursor === null ? 0 : cursor - 1),
    "first-row": () => select(0),
    "last-row": () => select(rows.length - 1),
    open: () => {
      const row = rows[cursor ?? -1];
      if (row) store.openResearch(row.id);
    },
    "next-issue": () => {
      const index = rows.findIndex((row) => row.id === open);
      const row = rows[index + 1];
      if (index >= 0 && row) store.openResearch(row.id);
    },
    "previous-issue": () => {
      const index = rows.findIndex((row) => row.id === open);
      const row = rows[index - 1];
      if (index >= 0 && row) store.openResearch(row.id);
    },
  });
  const cursorId = rows[cursor ?? -1]?.id;
  useEffect(() => {
    if (cursorId)
      document
        .getElementById(`research-${cursorId}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);
  const months: { label: string; entries: ResearchSummary[] }[] = [];
  for (const row of rows) {
    const label = new Date(row.startedAt).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    const last = months.at(-1);
    if (last?.label === label) last.entries.push(row);
    else months.push({ label, entries: [row] });
  }
  const current = entry?.id === open ? entry : null;
  return (
    <>
      <form
        className="list-toolbar research-request"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim())
            void act({
              kind: "start_research",
              id: crypto.randomUUID(),
              question,
              directory,
            });
        }}
      >
        <input
          aria-label="Research directory"
          placeholder="Absolute directory to read"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          required
        />
        <textarea
          aria-label="Research question"
          placeholder="What would you like to research?"
          maxLength={10000}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          disabled={
            !connected ||
            busy ||
            !!state?.runningId ||
            !question.trim() ||
            !directory.trim()
          }
        >
          {state?.runningId ? "Researching…" : "Research"}
        </button>
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              store.setCursor(null);
            }}
          />
          Archived
        </label>
      </form>
      <div className="list reviews-list" data-testid="research-list">
        {!connected ? (
          <p className="pad" role="status">
            Waiting for the coordinator…
          </p>
        ) : null}
        {error ? (
          <p className="pad" role="alert">
            {error}
          </p>
        ) : null}
        {connected && !state ? <p className="pad">Loading research…</p> : null}
        {state && !rows.length ? (
          <p className="pad faint">
            {archived
              ? "No archived research."
              : "Ask a question, or ask Main to save research from your conversation."}
          </p>
        ) : null}
        {months.map((month) => (
          <div key={month.label}>
            <ListGroupHeader
              label={month.label}
              count={month.entries.length}
              collapsed={false}
            />
            {month.entries.map((row) => (
              <ListRow
                key={row.id}
                id={`research-${row.id}`}
                cursor={cursorId === row.id}
                onOpen={() => store.openResearch(row.id)}
                leading={<span>{row.status === "completed" ? "✓" : "◌"}</span>}
                text={row.title ?? row.question}
                title={row.title ?? row.question}
                meta={
                  <span>
                    {row.origin === "main" ? "Saved by Main" : row.status}
                  </span>
                }
                age={new Date(row.startedAt).toLocaleDateString()}
              />
            ))}
          </div>
        ))}
      </div>
      {open ? (
        <DetailLayout
          className="research-detail"
          testId="research-detail"
          onClose={() => store.openResearch(null)}
          breadcrumb={
            <>
              <button type="button" onClick={() => store.openResearch(null)}>
                Research
              </button>
              <span>›</span>
              <span>
                {current?.document?.title ?? current?.question ?? "Loading…"}
              </span>
            </>
          }
        >
          <div className="pr-overview">
            <main className="pr-story">
              {error ? <p role="alert">{error}</p> : null}
              <h1>
                {current?.document?.title ?? current?.question ?? "Loading…"}
              </h1>
              {current ? (
                <>
                  <p className="faint">
                    {current.origin === "main"
                      ? "Saved by Main · From a conversation; no live-web verification claimed"
                      : `${current.provider} · ${current.model} · ${current.status}`}
                  </p>
                  <p>{current.question}</p>
                  {current.origin === "agent" ? (
                    <>
                      <p>
                        Scope: {current.directory} · Agent:{" "}
                        {current.observedStatus}
                      </p>
                      {current.pane ? (
                        <p>Research terminal is available in Workbench.</p>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act({ kind: "resume_research", id: current.id })
                        }
                      >
                        Resume terminal
                      </button>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (followUp.trim()) {
                            void act({
                              kind: "extend_research",
                              id: current.id,
                              message: followUp,
                            });
                            setFollowUp("");
                          }
                        }}
                      >
                        <textarea
                          aria-label="Research follow-up"
                          value={followUp}
                          onChange={(event) => setFollowUp(event.target.value)}
                          maxLength={16384}
                        />
                        <button
                          type="submit"
                          disabled={
                            busy ||
                            current.observedStatus !== "idle" ||
                            !followUp.trim()
                          }
                        >
                          Follow up
                        </button>
                      </form>
                    </>
                  ) : null}
                  {current.status === "running" ? (
                    <p role="status">
                      The agent is reading your directory and researching the
                      web. The document is saved when the agent submits it.
                    </p>
                  ) : null}
                  {current.error ? (
                    <p className="research-error" role="alert">
                      {current.error}
                    </p>
                  ) : null}
                  {current.document ? (
                    <PrMarkdown body={current.document.body} />
                  ) : null}
                </>
              ) : null}
            </main>
            <aside className="pr-rail">
              {current ? (
                <>
                  <h3>{current.status}</h3>
                  <button
                    type="button"
                    disabled={busy || !connected}
                    onClick={() =>
                      void act({
                        kind: "set_research_archived",
                        id: current.id,
                        archived: !current.archivedAt,
                      })
                    }
                  >
                    {current.archivedAt ? "Unarchive" : "Archive"}
                  </button>
                </>
              ) : null}
              {current?.document ? (
                <section>
                  <h3>Sources</h3>
                  <ul className="brief-sources">
                    {current.document.sources.map((source) => (
                      <li key={source.url}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </aside>
          </div>
        </DetailLayout>
      ) : null}
    </>
  );
}
