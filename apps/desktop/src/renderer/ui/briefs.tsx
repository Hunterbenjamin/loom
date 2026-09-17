import type { BriefContent, BriefRun, BriefRunSummary } from "@loom/protocol";
import { useEffect, useMemo, useState } from "react";
import { useBriefState } from "../store/brief-state.js";
import { useStore, useStoreApi } from "../store/react.js";
import { useSectionAdapter } from "../store/section-adapter.js";
import { historySectionItems } from "../store/section-list.js";
import { Byline } from "./byline.js";
import { DetailLayout } from "./detail-layout.js";
import { ListGroupHeader, ListRow } from "./list-rows.js";
import { ResearchGlyph as BriefGlyph, statusLabels } from "./research-glyph.js";
import { useTrackerActions } from "./tracker-actions.js";

const TIME_ZONE = "Asia/Makassar";
const evidenceLabels: Record<
  BriefContent["items"][number]["evidence"],
  string
> = {
  independently_tested: "Independently tested",
  author_reported: "Author-reported",
  practitioner_experience: "Practitioner experience",
  opinion: "Opinion",
};
const categoryLabels: Record<
  BriefContent["items"][number]["category"],
  string
> = {
  workflow: "Workflow",
  capability: "Capability",
  business: "Business",
  research: "Research",
};
const format = (at: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: TIME_ZONE,
    ...options,
  }).format(new Date(at));
const dateLabel = (at: string) =>
  format(at, { dateStyle: "medium", timeStyle: "short" });

/** What a history row says when the run has no headline yet, or never will. */
function rowText(run: BriefRunSummary): string {
  if (run.headline) return run.headline;
  if (run.status === "running") return "Researching live sources…";
  if (run.status === "failed") return "Research failed";
  if (run.status === "interrupted") return "Research interrupted";
  return "Brief";
}

/** The Daily brief page: its history as a list, and the open brief over it. */
export function BriefsView() {
  const store = useStoreApi();
  const connection = useStore((s) => s.connection);
  const cursor = useStore((s) => s.ui.cursor);
  const open = useStore((s) => s.ui.openBrief);
  const { state, error } = useBriefState();
  const connected = connection === "connected";
  const sections = useStore((s) => s.ui.briefSections);
  const openSummary = state?.runs.find((item) => item.id === open);

  const items = useMemo(() => {
    const months = new Map<string, BriefRunSummary[]>();
    for (const run of state?.runs ?? []) {
      const label = format(run.startedAt, { month: "long", year: "numeric" });
      const runs = months.get(label) ?? [];
      runs.push(run);
      months.set(label, runs);
    }
    return historySectionItems(
      [...months].map(([id, rows]) => ({
        id,
        rows,
        collapsed: sections[id] ?? false,
      })),
    );
  }, [state, sections]);
  const selected = useSectionAdapter(
    {
      items,
      cursor,
      setCursor: store.setCursor,
      toggle: store.toggleBriefSection,
      loadMore: () => {},
      open: (run) => store.openBrief(run.id),
    },
    !open,
  );
  const rows = state?.runs ?? [];
  useTrackerActions({
    ...(open
      ? {
          "next-issue": () => {
            const index = rows.findIndex((row) => row.id === open);
            const row = rows[index + 1];
            if (index >= 0 && row) store.openBrief(row.id);
          },
          "previous-issue": () => {
            const index = rows.findIndex((row) => row.id === open);
            const row = rows[index - 1];
            if (index >= 0 && row) store.openBrief(row.id);
          },
        }
      : {}),
  });
  const cursorKey = items[selected ?? -1]?.key;
  useEffect(() => {
    if (!cursorKey) return;
    document
      .querySelector('.briefs-list [data-cursor="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursorKey]);
  return (
    <>
      <div className="list reviews-list briefs-list" data-testid="briefs-list">
        {error ? (
          <p className="pad" role="alert">
            {error}
          </p>
        ) : null}
        {!state ? (
          <div className="pad faint" role="status">
            Loading briefs…
          </div>
        ) : !state.runs.length ? (
          <div className="pad faint" role="status">
            Your first brief will appear here. Run a daily brief from the create
            palette (c) or wait for the morning edition. Loom’s coordinator must
            be running; after sleep, today’s missed brief runs when it wakes.
          </div>
        ) : null}
        {items.map((item, index) =>
          item.kind === "header" ? (
            <ListGroupHeader
              key={item.key}
              label={item.section}
              count={item.count}
              collapsed={item.collapsed}
              cursor={selected === index}
              onToggle={() => store.toggleBriefSection(item.section)}
            />
          ) : item.kind === "row" ? (
            <ListRow
              key={item.key}
              cursor={selected === index}
              onOpen={() => store.openBrief(item.row.id)}
              leading={<BriefGlyph status={item.row.status} />}
              text={rowText(item.row)}
              title={rowText(item.row)}
              data-brief={item.row.id}
              id={`brief-row-${item.row.id}`}
              meta={
                <span>
                  {item.row.trigger === "scheduled" ? "Daily" : "Manual"}
                </span>
              }
              age={format(item.row.startedAt, {
                month: "short",
                day: "numeric",
              })}
            />
          ) : null,
        )}
      </div>
      {open ? (
        <BriefDetail
          key={open}
          id={open}
          summary={openSummary}
          connected={connected}
        />
      ) : null}
    </>
  );
}

/** One brief, laid out like the Reviews detail: reading column and property rail. */
function BriefDetail({
  id,
  summary,
  connected,
}: {
  id: string;
  summary: BriefRunSummary | undefined;
  connected: boolean;
}) {
  const store = useStoreApi();
  const [run, setRun] = useState<BriefRun | null>(null);
  const [error, setError] = useState("");
  // Reread when the history reports a new status, so a finishing run fills in.
  const status = summary?.status;
  useEffect(() => {
    if (!connected || !status) return;
    let disposed = false;
    void store
      .command({ kind: "get_brief", id })
      .then((result) => {
        if (disposed) return;
        if (!result.ok) setError(result.error.message);
        else if (result.result.kind === "brief") {
          setRun(result.result.run);
          setError("");
        }
      })
      .catch((error: unknown) => {
        if (!disposed)
          setError(
            error instanceof Error ? error.message : "Could not read brief",
          );
      });
    return () => {
      disposed = true;
    };
  }, [store, id, status, connected]);
  const current = run ?? summary;
  const content = run?.content ?? null;
  const title = content?.headline ?? (summary ? rowText(summary) : "Brief");
  const close = () => store.openBrief(null);
  const sources = content
    ? new Set(content.items.flatMap((item) => item.sources.map((s) => s.url)))
        .size
    : 0;

  return (
    <DetailLayout
      className="brief-detail"
      testId="brief-detail"
      onClose={close}
      breadcrumb={
        <>
          <button type="button" onClick={close}>
            Daily brief
          </button>
          <span className="faint">›</span>
          {current ? <BriefGlyph status={current.status} /> : null}
          <span className="pr-header-title" title={title}>
            {title}
          </span>
        </>
      }
    >
      {error ? (
        <div className="pr-feedback" role="alert">
          {error}
        </div>
      ) : null}
      <div className="pr-overview">
        <main className="pr-story">
          <h1>{title}</h1>
          {current ? (
            <Byline name="Loom brief agent" agent model={current.model}>
              <span className="faint">{dateLabel(current.startedAt)}</span>
              <span className="faint">·</span>
              <span className="faint">
                {current.trigger === "scheduled"
                  ? "Daily edition"
                  : "Manual run"}
              </span>
            </Byline>
          ) : null}
          {current?.status === "running" ? (
            <p className="pr-description" role="status">
              Researching live sources. You can leave this page; the brief is
              saved when it finishes.
            </p>
          ) : null}
          {current?.error ? (
            <p className="pr-description" role="alert">
              {current.error}
            </p>
          ) : null}
          {content ? (
            <>
              <section className="pr-description">
                <h3>Summary</h3>
                <p>{content.summary}</p>
              </section>
              {content.items.map((item, index) => (
                <section
                  className="pr-description brief-item"
                  id={`brief-item-${index}`}
                  key={item.title}
                >
                  <h3>
                    {categoryLabels[item.category]} ·{" "}
                    {evidenceLabels[item.evidence]}
                    {item.publishedOn
                      ? ` · Published ${item.publishedOn}`
                      : " · Publication date unverified"}
                  </h3>
                  <h2>{item.title}</h2>
                  <p>{item.whatChanged}</p>
                  <h4>Why it matters to you</h4>
                  <p>{item.implication}</p>
                  <h4>Evidence and limitations</h4>
                  <p>{item.caveat}</p>
                  <h4>What to do next</h4>
                  <p>{item.nextStep}</p>
                  <ul className="brief-sources">
                    {item.sources.map((source) => (
                      <li key={source.url}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <section className="pr-description brief-item">
                <h3>Try this</h3>
                <h2>A workflow experiment</h2>
                <p>{content.workflowExperiment}</p>
              </section>
              {content.opportunity ? (
                <section className="pr-description brief-item">
                  <h3>Opportunity</h3>
                  <h2>Business opportunity to investigate</h2>
                  <p>{content.opportunity}</p>
                </section>
              ) : null}
            </>
          ) : null}
        </main>
        <aside className="pr-rail" aria-label="Brief properties">
          <section>
            <h3>Status</h3>
            {current ? (
              <div className="pr-property">
                <BriefGlyph status={current.status} />
                {statusLabels[current.status]}
              </div>
            ) : (
              <div className="pr-property faint">Loading…</div>
            )}
          </section>
          {current ? (
            <section>
              <h3>Edition</h3>
              <div className="pr-property">
                {current.trigger === "scheduled"
                  ? `Daily · ${current.scheduledDate ?? format(current.startedAt, { dateStyle: "medium" })}`
                  : "Manual run"}
              </div>
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
          {content?.items.length ? (
            <section className="brief-contents">
              <h3>In this brief</h3>
              {content.items.map((item, index) => (
                <button
                  type="button"
                  className="pr-property"
                  key={item.title}
                  onClick={() =>
                    document
                      .getElementById(`brief-item-${index}`)
                      ?.scrollIntoView({ block: "start" })
                  }
                >
                  <span className="brief-contents-title">{item.title}</span>
                  <span className="faint">{categoryLabels[item.category]}</span>
                </button>
              ))}
            </section>
          ) : null}
          {content ? (
            <section>
              <h3>Sources</h3>
              <div className="pr-property">
                {sources} {sources === 1 ? "source" : "sources"}
              </div>
              <p className="faint brief-coverage">{content.coverage}</p>
            </section>
          ) : null}
        </aside>
      </div>
    </DetailLayout>
  );
}
