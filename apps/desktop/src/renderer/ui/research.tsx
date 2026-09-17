import type {
  Command,
  ResearchComment,
  ResearchEntry,
  ResearchState,
} from "@loom/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { useSectionAdapter } from "../store/section-adapter.js";
import { historySectionItems } from "../store/section-list.js";
import { ActivityList } from "./activity.js";
import { Byline } from "./byline.js";
import { CommentComposer } from "./comment-composer.js";
import { DetailLayout } from "./detail-layout.js";
import { ListGroupHeader, ListRow } from "./list-rows.js";
import { PrMarkdown } from "./pull-request-overview.js";
import { ResearchGlyph } from "./research-glyph.js";
import { useTrackerActions } from "./tracker-actions.js";
import { keyHint } from "./tracker-keymap.js";

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
  const [comments, setComments] = useState<ResearchComment[]>([]);
  const sections = useStore((s) => s.ui.researchSections);
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
        const result = await store.command({
          kind: "list_research",
          archived: "all",
        });
        if (!result.ok) throw new Error(result.error.message);
        if (!disposed && result.result.kind === "research_list")
          setState(result.result.state);
        if (open) {
          const detail = await store.command({
            kind: "read_research",
            id: open,
          });
          if (!detail.ok) throw new Error(detail.error.message);
          if (!disposed && detail.result.kind === "research_entry") {
            setEntry(detail.result.entry);
            setComments(detail.result.comments);
          }
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
  }, [store, connected, open]);
  const act = async (command: Command) => {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    try {
      const result = await store.command(command);
      if (!result.ok) throw new Error(result.error.message);
      if (result.result.kind === "research_entry") {
        setEntry(result.result.entry);
        setComments(result.result.comments);
      }
      await refreshResearch.current?.();
      setError("");
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action failed");
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const items = useMemo(
    () =>
      historySectionItems(
        (["active", "archived"] as const).map((id) => ({
          id,
          rows: (state?.entries ?? []).filter(
            (row) => Boolean(row.archivedAt) === (id === "archived"),
          ),
          collapsed: sections[id] ?? id === "archived",
        })),
      ),
    [state, sections],
  );
  const selected = useSectionAdapter(
    {
      items,
      cursor,
      setCursor: store.setCursor,
      toggle: store.toggleResearchSection,
      loadMore: () => {},
      open: (row) => store.openResearch(row.id),
    },
    !open,
  );
  const rows = items.flatMap((item) => (item.kind === "row" ? [item.row] : []));
  const current = entry?.id === open ? entry : null;
  const item = items[selected ?? -1];
  const target = open ? current : item?.kind === "row" ? item.row : null;
  const archive = () => {
    if (target && connected && !busy)
      void act({
        kind: "set_research_archived",
        id: target.id,
        archived: !target.archivedAt,
      });
  };
  useTrackerActions({
    ...(target ? { archive } : {}),
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
  const cursorKey = items[selected ?? -1]?.key;
  useEffect(() => {
    if (!cursorKey) return;
    document
      .querySelector('.research-list [data-cursor="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursorKey]);
  return (
    <>
      <div
        className="list reviews-list research-list"
        data-testid="research-list"
      >
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
        {state && !state.entries.length ? (
          <p className="pad faint">
            Create research from the create palette, or ask Main to save
            research from your conversation.
          </p>
        ) : null}
        {items.map((item, index) =>
          item.kind === "header" ? (
            <ListGroupHeader
              key={item.key}
              label={item.section === "active" ? "Active" : "Archived"}
              count={item.count}
              collapsed={item.collapsed}
              cursor={selected === index}
              onToggle={() => store.toggleResearchSection(item.section)}
            />
          ) : item.kind === "row" ? (
            <ListRow
              key={item.key}
              id={`research-${item.row.id}`}
              cursor={selected === index}
              onOpen={() => store.openResearch(item.row.id)}
              leading={<ResearchGlyph status={item.row.status} />}
              text={item.row.name}
              title={item.row.question}
              meta={
                item.row.origin === "main" ? <span>Saved by Main</span> : null
              }
              age={new Date(item.row.startedAt).toLocaleDateString()}
            />
          ) : null,
        )}
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
              <span>{current?.name ?? "Loading…"}</span>
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
              <h1>{current?.name ?? "Loading…"}</h1>
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
                  <h2>{current.document.title}</h2>
                  <PrMarkdown body={current.document.body} />
                </section>
              ) : null}
              {current ? (
                <>
                  <ActivityList
                    key={current.id}
                    title="Comments"
                    items={comments.map((comment) => ({
                      id: comment.id,
                      at: comment.at,
                      kind: "comment",
                      url: null,
                      label: `${comment.author === "human" ? "You" : comment.author === "main" ? "Main" : "Research agent"}${comment.delivered ? "" : " · queued"}`,
                      body: comment.text,
                    }))}
                  />
                  <CommentComposer
                    key={`${current.id}-composer`}
                    disabled={busy || !connected}
                    label="Research comment"
                    maxLength={16384}
                    placeholder={
                      current.origin === "agent"
                        ? "Leave a note, or mention @loom to continue research…"
                        : "Leave a note…"
                    }
                    post={(message, requestId) =>
                      act({
                        kind: "comment_research",
                        id: current.id,
                        message,
                        requestId,
                      })
                    }
                  />
                </>
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
                    {...keyHint(
                      "archive",
                      current.archivedAt ? "Unarchive" : "Archive",
                    )}
                    onClick={archive}
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
