import type {
  BriefContent,
  BriefRun,
  BriefRunSummary,
  BriefState,
  Command,
} from "@loom/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { Byline } from "./byline.js";
import { DetailLayout } from "./detail-layout.js";
import { ListGroupHeader, ListRow } from "./list-rows.js";
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
const statusLabels: Record<BriefRunSummary["status"], string> = {
  running: "Researching",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
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

function BriefGlyph({ status }: { status: BriefRunSummary["status"] }) {
  const [symbol, tone] =
    status === "completed"
      ? ["✓", "good"]
      : status === "running"
        ? ["●", "attention"]
        : status === "failed"
          ? ["×", "danger"]
          : ["◌", ""];
  return (
    <span
      className={`review-status ${tone}`}
      role="img"
      aria-label={statusLabels[status]}
      title={statusLabels[status]}
    >
      {symbol}
    </span>
  );
}

/** The Daily brief page: its history as a list, and the open brief over it. */
export function BriefsView() {
  const store = useStoreApi();
  const connection = useStore((s) => s.connection);
  const cursor = useStore((s) => s.ui.cursor);
  const open = useStore((s) => s.ui.openBrief);
  const [state, setState] = useState<BriefState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const connected = connection === "connected";
  useEffect(() => {
    if (!connected) {
      setError("Waiting for the coordinator…");
      return;
    }
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await store.command({ kind: "get_briefs" });
        if (disposed) return;
        if (!result.ok) throw new Error(result.error.message);
        if (result.result.kind === "briefs") {
          setState(result.result.state);
          setError("");
        }
      } catch (error) {
        if (!disposed)
          setError(
            error instanceof Error ? error.message : "Could not load briefs",
          );
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [store, connected]);
  const act = async (command: Command) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await store.command(command);
      if (!result.ok) throw new Error(result.error.message);
      const refreshed = await store.command({ kind: "get_briefs" });
      if (!refreshed.ok) throw new Error(refreshed.error.message);
      if (refreshed.result.kind === "briefs") setState(refreshed.result.state);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action failed");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const running = state?.runs.some((item) => item.status === "running");
  const openSummary = state?.runs.find((item) => item.id === open);

  const rows = state?.runs ?? [];
  const select = (index: number) => {
    store.setCursor(
      rows.length ? Math.max(0, Math.min(rows.length - 1, index)) : null,
    );
  };
  useTrackerActions({
    "next-row": () => select(cursor === null ? 0 : cursor + 1),
    "previous-row": () => select(cursor === null ? 0 : cursor - 1),
    "first-row": () => select(0),
    "last-row": () => select(rows.length - 1),
    open: () => {
      const row = rows[cursor ?? -1];
      if (row) store.openBrief(row.id);
    },
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
  const cursorId = rows[cursor ?? -1]?.id;
  useEffect(() => {
    if (cursorId)
      document
        .getElementById(`brief-row-${cursorId}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);
  const months: { label: string; runs: BriefRunSummary[] }[] = [];
  for (const run of rows) {
    const label = format(run.startedAt, { month: "long", year: "numeric" });
    const last = months.at(-1);
    if (last?.label === label) last.runs.push(run);
    else months.push({ label, runs: [run] });
  }

  return (
    <>
      <div className="list-toolbar briefs-toolbar">
        <span className="faint">
          Daily at 7:00 a.m. · {TIME_ZONE} · Claude Sonnet, $3 limit per run
        </span>
        <span className="spacer" />
        <label className="briefs-schedule">
          <input
            type="checkbox"
            checked={state?.schedule.enabled ?? false}
            disabled={!state || busy}
            onChange={(event) =>
              void act({
                kind: "set_brief_schedule",
                enabled: event.target.checked,
              })
            }
          />
          Daily schedule
        </label>
        <button
          type="button"
          className="briefs-run"
          disabled={busy || running || !state}
          onClick={() =>
            void act({ kind: "run_brief", id: crypto.randomUUID() })
          }
        >
          {running ? "Researching…" : "Run now"}
        </button>
      </div>
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
            Your first brief will appear here. Run it now or wait for the
            morning edition. Loom’s coordinator must be running; after sleep,
            today’s missed brief runs when it wakes.
          </div>
        ) : null}
        {months.map((month) => (
          <div key={month.label}>
            <ListGroupHeader
              label={month.label}
              count={month.runs.length}
              collapsed={false}
            />
            {month.runs.map((run) => (
              <ListRow
                key={run.id}
                cursor={cursorId === run.id}
                onOpen={() => store.openBrief(run.id)}
                leading={<BriefGlyph status={run.status} />}
                text={rowText(run)}
                title={rowText(run)}
                data-brief={run.id}
                id={`brief-row-${run.id}`}
                meta={
                  <span>
                    {run.trigger === "scheduled" ? "Daily" : "Manual"}
                  </span>
                }
                age={format(run.startedAt, { month: "short", day: "numeric" })}
              />
            ))}
          </div>
        ))}
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
