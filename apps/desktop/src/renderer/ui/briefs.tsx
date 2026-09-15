import type { BriefRun, BriefState, Command } from "@loom/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";

const evidenceLabels = {
  independently_tested: "Independently tested",
  author_reported: "Author-reported",
  practitioner_experience: "Practitioner experience",
  opinion: "Opinion",
};
const dateLabel = (at: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: "Asia/Makassar",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));

export function BriefsView() {
  const store = useStoreApi();
  const connection = useStore((s) => s.connection);
  const [state, setState] = useState<BriefState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<BriefRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    if (connection !== "connected" && connection !== "fixtures") {
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
  }, [store, connection]);
  const selectedId = selected ?? state?.runs[0]?.id;
  const selectedStatus = state?.runs.find(
    (item) => item.id === selectedId,
  )?.status;
  useEffect(() => {
    let disposed = false;
    setRun(null);
    if (
      selectedId &&
      selectedStatus &&
      (connection === "connected" || connection === "fixtures")
    )
      void store
        .command({ kind: "get_brief", id: selectedId })
        .then((result) => {
          if (disposed) return;
          if (!result.ok) setError(result.error.message);
          else if (result.result.kind === "brief") setRun(result.result.run);
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
  }, [store, selectedId, selectedStatus, connection]);
  const act = async (command: Command) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await store.command(command);
      if (!result.ok) throw new Error(result.error.message);
      if (result.result.kind === "brief") {
        setSelected(result.result.run.id);
        setRun(result.result.run);
      }
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
  return (
    <section className="briefs-view" aria-label="Daily AI brief">
      <div className="briefs-controls">
        <div>
          <strong>Your AI builder brief</strong>
          <p className="faint">Daily at 7:00 a.m. · Asia/Makassar</p>
        </div>
        <span className="spacer" />
        <label>
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
          />{" "}
          Daily schedule
        </label>
        <button
          type="button"
          disabled={busy || running || !state}
          onClick={() =>
            void act({ kind: "run_brief", id: crypto.randomUUID() })
          }
        >
          {running ? "Researching…" : "Run now"}
        </button>
      </div>
      <p className="faint">
        Agent workflows, new capabilities, research implications and business
        opportunities. Uses Claude Sonnet with a $3 budget limit per run. Loom’s
        coordinator must be running; after sleep, today’s missed brief runs when
        it wakes.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {state?.runs.length ? (
        <label className="briefs-history">
          History{" "}
          <select
            aria-label="Brief history"
            value={selectedId}
            onChange={(event) => setSelected(event.target.value)}
          >
            {state.runs.map((item) => (
              <option key={item.id} value={item.id}>
                {dateLabel(item.startedAt)} · {item.trigger} · {item.status}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>
          {state
            ? "Your first brief will appear here. Run it now or wait for the morning edition."
            : "Loading briefs…"}
        </p>
      )}
      {run?.status === "running" ? (
        <p role="status">
          Researching live sources. You can leave this page; the brief will be
          saved when it finishes.
        </p>
      ) : null}
      {run?.error ? <p role="alert">{run.error}</p> : null}
      {run?.content ? (
        <article className="briefs-content">
          <h2>{run.content.headline}</h2>
          <p className="faint">{dateLabel(run.startedAt)} · Asia/Makassar</p>
          <p>{run.content.summary}</p>
          {run.content.items.map((item) => (
            <section className="briefs-item" key={item.title}>
              <div className="faint">
                {item.category} · {evidenceLabels[item.evidence]}
                {item.publishedOn
                  ? ` · Published ${item.publishedOn}`
                  : " · Publication date unverified"}
              </div>
              <h3>{item.title}</h3>
              <p>{item.whatChanged}</p>
              <h4>Why it matters to you</h4>
              <p>{item.implication}</p>
              <h4>Evidence and limitations</h4>
              <p>{item.caveat}</p>
              <h4>What to do next</h4>
              <p>{item.nextStep}</p>
              <ul>
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
          <section className="briefs-item">
            <h3>A workflow experiment</h3>
            <p>{run.content.workflowExperiment}</p>
          </section>
          {run.content.opportunity ? (
            <section className="briefs-item">
              <h3>Business opportunity to investigate</h3>
              <p>{run.content.opportunity}</p>
            </section>
          ) : null}
          <p className="faint">Coverage: {run.content.coverage}</p>
        </article>
      ) : null}
    </section>
  );
}
