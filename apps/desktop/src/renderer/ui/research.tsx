import type {
  Command,
  ResearchEntry,
  ResearchState,
  ResearchSummary,
} from "@loom/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { Byline } from "./byline.js";
import { DetailLayout } from "./detail-layout.js";
import { ListGroupHeader, ListRow } from "./list-rows.js";
import { PrMarkdown } from "./pull-request-overview.js";
import { useTrackerActions } from "./tracker-actions.js";

const dateLabel = (at: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));

export function ResearchView() {
  const store = useStoreApi();
  const connected = useStore((s) => s.connection === "connected");
  const open = useStore((s) => s.ui.openResearch);
  const cursor = useStore((s) => s.ui.cursor);
  const [state, setState] = useState<ResearchState | null>(null);
  const [entry, setEntry] = useState<ResearchEntry | null>(null);
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
  const rows = state?.entries ?? [];
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
      <div className="list-toolbar">
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
      </div>
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
              : "Create research from the create palette, or ask Main to save research from your conversation."}
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
              {error ? (
                <div className="pr-feedback" role="alert">
                  {error}
                </div>
              ) : null}
              <h1>
                {current?.document?.title ?? current?.question ?? "Loading…"}
              </h1>
              {current ? (
                <Byline
                  name={current.origin === "main" ? "Main" : "Research agent"}
                  agent
                  model={current.model ?? undefined}
                  title={
                    current.origin === "main"
                      ? "Saved from a conversation; no live-web verification claimed"
                      : (current.provider ?? undefined)
                  }
                >
                  <span className="faint">{dateLabel(current.startedAt)}</span>
                  <span className="faint">·</span>
                  <span className="faint">
                    {current.origin === "main" ? "Saved by Main" : "Researched"}
                  </span>
                </Byline>
              ) : null}
              {current?.origin === "main" ? (
                <p className="pr-description faint">
                  Saved from a conversation; no live-web verification claimed.
                </p>
              ) : null}
              {current ? (
                <section className="pr-description">
                  <h3>Question</h3>
                  <p>{current.question}</p>
                </section>
              ) : null}
              {current?.status === "running" ? (
                <p className="pr-description" role="status">
                  The agent is reading your directory and researching the web.
                  The document is saved when the agent submits it.
                </p>
              ) : null}
              {current?.error ? (
                <p className="pr-description" role="alert">
                  {current.error}
                </p>
              ) : null}
              {current?.document ? (
                <section className="pr-description">
                  <PrMarkdown body={current.document.body} />
                </section>
              ) : null}
              {current?.origin === "agent" ? (
                <section className="pr-description research-followups">
                  <h3>Follow up</h3>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!followUp.trim()) return;
                      void act({
                        kind: "extend_research",
                        id: current.id,
                        message: followUp,
                      });
                      setFollowUp("");
                    }}
                  >
                    <textarea
                      aria-label="Research follow-up"
                      placeholder="Ask the agent to dig further; it keeps this document and adds to it."
                      value={followUp}
                      onChange={(event) => setFollowUp(event.target.value)}
                      maxLength={16384}
                      rows={3}
                    />
                    <div className="research-followup-actions">
                      <span className="faint">
                        {current.observedStatus === "idle"
                          ? "Agent is idle"
                          : `Agent is ${current.observedStatus}`}
                      </span>
                      <button
                        type="submit"
                        disabled={
                          busy ||
                          current.observedStatus !== "idle" ||
                          !followUp.trim()
                        }
                      >
                        Send
                      </button>
                    </div>
                  </form>
                </section>
              ) : null}
            </main>
            <aside className="pr-rail" aria-label="Properties">
              {current ? (
                <section>
                  <h3>Status</h3>
                  <div className="pr-property">{current.status}</div>
                  {current.origin === "agent" ? (
                    <div className="pr-property faint">
                      Agent {current.observedStatus}
                    </div>
                  ) : null}
                  <div className="pr-property faint">
                    Started {dateLabel(current.startedAt)}
                  </div>
                  {current.finishedAt ? (
                    <div className="pr-property faint">
                      Finished {dateLabel(current.finishedAt)}
                    </div>
                  ) : null}
                </section>
              ) : null}
              {current?.origin === "agent" ? (
                <section>
                  <h3>Run</h3>
                  {current.provider ? (
                    <div className="pr-property">
                      {current.provider} · {current.model}
                    </div>
                  ) : null}
                  {current.directory ? (
                    <div
                      className="pr-property mono faint"
                      title={current.directory}
                    >
                      {current.directory}
                    </div>
                  ) : null}
                  {current.pane ? (
                    <button
                      type="button"
                      className="pr-property"
                      disabled={busy}
                      onClick={() =>
                        void act({ kind: "resume_research", id: current.id })
                      }
                    >
                      Open terminal in Workbench
                    </button>
                  ) : null}
                </section>
              ) : null}
              {current?.document?.sources.length ? (
                <section>
                  <h3>Sources</h3>
                  <ul className="brief-sources">
                    {current.document.sources.map((source) => (
                      <li key={source.url}>
                        {/^https?:\/\//.test(source.url) ? (
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                          </a>
                        ) : (
                          // A local citation is a path in the run's directory, not a link.
                          <span className="mono" title={source.url}>
                            {source.title}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {current ? (
                <section>
                  <h3>Actions</h3>
                  <button
                    type="button"
                    className="pr-property"
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
                </section>
              ) : null}
            </aside>
          </div>
        </DetailLayout>
      ) : null}
    </>
  );
}
