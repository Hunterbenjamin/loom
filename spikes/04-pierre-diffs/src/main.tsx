import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  parsePatchFiles,
  parseDiffFromFile,
  type CodeViewDiffItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  CodeView,
  FileDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  useWorkerPool,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import type { CodeViewLineSelection } from "@pierre/diffs";
import Worker from "@pierre/diffs/worker/worker.js?worker";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { configSchema, fixtureSchema, manifestSchema, type Fixture } from "./schema";
import { capture, relocate } from "./anchors";
import "./style.css";

const config = configSchema.parse(Object.fromEntries(new URLSearchParams(location.search)));
const metrics: Record<string, unknown> = {
  config,
  startedAt: performance.now(),
  firstDiffMs: null,
  firstDiffNavigationMs: null,
  firstHighlightMs: null,
  firstHighlightNavigationMs: null,
  parseMs: null,
  workerStats: null,
};
const errors: string[] = [];
let mountedAt = 0;
let paintPending = false;
const onPostRender = () => {
  if ((metrics.firstDiffMs != null && metrics.firstHighlightMs != null) || paintPending) return;
  paintPending = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      paintPending = false;
      if (metrics.firstDiffMs == null) {
        metrics.firstDiffMs = performance.now() - mountedAt;
        metrics.firstDiffNavigationMs = performance.now();
      }
      if (
        metrics.firstHighlightMs == null &&
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector('[data-code] [style*="--diffs-token-"]')
      ) {
        metrics.firstHighlightMs = performance.now() - mountedAt;
        metrics.firstHighlightNavigationMs = performance.now();
      }
    }),
  );
};
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
const longTasks: number[] = [];
new PerformanceObserver((list) =>
  longTasks.push(...list.getEntries().map((e) => e.duration)),
).observe({ type: "longtask", buffered: true });
type Finding = {
  id: string;
  file: string;
  line: number;
  side: "additions" | "deletions";
  severity: string;
  resolved: boolean;
  replies: string[];
  draft: string;
};
type Api = {
  metrics: typeof metrics;
  errors: string[];
  longTasks: number[];
  snapshot?: () => unknown;
  scrollTo?: (index: number) => void;
};
declare global {
  interface Window {
    spike: Api;
  }
}
window.spike = { metrics, errors, longTasks };
const poolOptions = { workerFactory: () => new Worker(), poolSize: 4, totalASTLRUCacheSize: 100 };
const highlighterOptions = {
  langs: ["typescript", "yaml"],
  theme: { dark: "github-dark", light: "github-light" },
};

function PoolProbe() {
  const pool = useWorkerPool();
  useEffect(() => {
    if (!pool) return;
    metrics.workerStats = pool.getStats();
    return pool.subscribeToStatChanges((stats) => {
      metrics.workerStats = stats;
    });
  }, [pool]);
  return null;
}

function App({ fixture, initialDiffs }: { fixture: Fixture; initialDiffs: FileDiffMetadata[] }) {
  const [diffs, setDiffs] = useState(initialDiffs);
  const [theme, setTheme] = useState(config.theme);
  const [view, setView] = useState(config.view);
  const [revision, setRevision] = useState(0);
  const [viewed, setViewed] = useState(new Set<string>());
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);
  const [active, setActive] = useState(0);
  const [replacement, setReplacement] = useState("Original diff");
  const [findings, setFindings] = useState<Finding[]>(() =>
    Array.from({ length: config.annotations }, (_, i) => {
      const file = diffs[i % diffs.length];
      const hunk = file.hunks[Math.floor(i / diffs.length) % file.hunks.length];
      return {
        id: `finding-${i}`,
        file: file.name,
        line: Math.max(1, hunk.additionStart),
        side: "additions",
        severity: ["High", "Medium", "Info"][i % 3],
        resolved: false,
        replies: ["Agent: please verify this branch.", "Reviewer: checking the edge case."],
        draft: "",
      };
    }),
  );
  const ref = useRef<CodeViewHandle<string, undefined>>(null);
  const options = useMemo(
    () => ({
      theme: { dark: "github-dark", light: "github-light" },
      themeType: theme,
      diffStyle: view,
      diffIndicators: "bars" as const,
      enableLineSelection: true,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      onPostRender,
      disableErrorHandling: true,
      // Only static application-owned CSS; no external patch data is interpolated here.
      unsafeCSS:
        ':host { --diffs-font-family: "JetBrains Mono Variable", monospace; --diffs-font-size: 12px; --diffs-line-height: 20px; }',
      itemMetrics: { lineHeight: 20 },
      loadDiffFiles: async (file: FileDiffMetadata) => {
        const pair = fixture.contents[file.name];
        if (!pair) throw new Error("Full contents unavailable for this fixture");
        return {
          oldFile: {
            name: file.prevName ?? file.name,
            contents: pair.old,
            cacheKey: `${fixture.sha256}:old:${file.name}`,
          },
          newFile: {
            name: file.name,
            contents: pair.new,
            cacheKey: `${fixture.sha256}:new:${file.name}`,
          },
        };
      },
    }),
    [theme, view, fixture],
  );
  const items: CodeViewDiffItem<string>[] = useMemo(
    () =>
      diffs.map((fileDiff) => ({
        id: fileDiff.name,
        type: "diff",
        fileDiff,
        version: revision,
        collapsed: collapsed.has(fileDiff.name),
        annotations: findings
          .filter((f) => f.file === fileDiff.name)
          .map((f) => ({ side: f.side, lineNumber: f.line, metadata: f.id })),
      })),
    [diffs, revision, findings, collapsed],
  );
  const update = (id: string, patch: Partial<Finding>) => {
    setFindings((all) => all.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    setRevision((v) => v + 1);
  };
  const renderAnnotation = (annotation: { metadata: string }) => {
    const finding = findings.find((f) => f.id === annotation.metadata);
    if (!finding) return null;
    return (
      <article className="finding" data-finding={finding.id}>
        <div className="finding-head">
          <strong className={finding.severity.toLowerCase()}>{finding.severity}</strong>
          <span className="chip">{finding.resolved ? "Resolved" : "Open"}</span>
          <span>
            {finding.id} · {finding.side}:{finding.line}
          </span>
        </div>
        <p>Validate the changed behavior before merging.</p>
        <div className="replies">
          {finding.replies.map((reply, i) => (
            <p key={`${i}:${reply}`}>{reply}</p>
          ))}
        </div>
        <div className="reply">
          <input
            aria-label={`Reply ${finding.id}`}
            value={finding.draft}
            onChange={(e) => update(finding.id, { draft: e.target.value })}
            placeholder="Add a reply…"
          />
          <button
            onClick={() =>
              update(finding.id, { replies: [...finding.replies, finding.draft], draft: "" })
            }
          >
            Reply
          </button>
          <button onClick={() => update(finding.id, { resolved: !finding.resolved })}>
            {finding.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      </article>
    );
  };
  const jump = (index: number) => {
    const clamped = Math.max(0, Math.min(diffs.length - 1, index));
    setActive(clamped);
    if (ref.current)
      ref.current.scrollTo({ type: "item", id: diffs[clamped].name, align: "start" });
    else document.querySelector(`[data-file-index="${clamped}"]`)?.scrollIntoView();
  };
  useEffect(() => {
    window.spike.scrollTo = jump;
    window.spike.snapshot = () => ({
      findings,
      revision,
      replacement,
      selection,
      active,
      viewed: [...viewed],
      items: items.map((i) => ({ id: i.id, version: i.version, annotations: i.annotations })),
      rendered: ref.current
        ?.getInstance()
        ?.getRenderedItems()
        .map((i) => ({
          id: i.id,
          version: i.version,
          name: i.item.type === "diff" ? i.item.fileDiff.name : "",
        })),
    });
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const replace = (reanchor: boolean, bump: boolean) => {
    const first = initialDiffs[0];
    const pair = fixture.contents[first.name];
    if (!pair) return;
    const next =
      Array.from({ length: 5 }, (_, i) => `// inserted header ${i}\n`).join("") + pair.new;
    const diff = parseDiffFromFile(
      { name: first.name, contents: pair.old, cacheKey: `${fixture.sha256}:base` },
      { name: first.name, contents: next, cacheKey: `${fixture.sha256}:revision-2` },
    );
    setDiffs([diff, ...initialDiffs.slice(1)]);
    if (reanchor)
      setFindings((all) =>
        all.map((f) => {
          if (f.file !== first.name || f.side !== "additions") return f;
          const result = relocate(capture(pair.new.split("\n"), f.line), next.split("\n"));
          return "line" in result ? { ...f, line: result.line } : f;
        }),
      );
    if (bump) setRevision((v) => v + 1);
    setReplacement(
      `New contents; ${bump ? "version bumped" : "same version"}; ${reanchor ? "reanchored" : "original line positions"}`,
    );
  };
  const toggle = (set: Set<string>, name: string) => {
    const next = new Set(set);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  };
  return (
    <>
      <PoolProbe />
      <header>
        <div>
          <b>Loom</b>
          <span> / Diff review spike</span>
        </div>
        <div className="controls">
          <select
            aria-label="Fixture"
            value={config.fixture}
            onChange={(e) => {
              const q = new URLSearchParams(location.search);
              q.set("fixture", e.target.value);
              location.search = q.toString();
            }}
          >
            {["medium", "large", "single", "lockfile", "commits", "github", "edges"].map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
          <button onClick={() => setView((v) => (v === "split" ? "unified" : "split"))}>
            {view === "split" ? "Unified" : "Split"}
          </button>
          <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>
      <main
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            jump(active + (e.key === "ArrowDown" ? 1 : -1));
          }
        }}
      >
        <aside>
          <h3>
            {diffs.length} files{" "}
            <small>
              +{fixture.added} −{fixture.deleted}
            </small>
          </h3>
          <p className="hint">Alt ↑ / ↓ to jump files</p>
          {diffs.map((file, i) => (
            <div className={`file ${active === i ? "active" : ""}`} key={file.name}>
              <input
                type="checkbox"
                aria-label={`Viewed ${i}`}
                checked={viewed.has(file.name)}
                onChange={() => setViewed(toggle(viewed, file.name))}
              />
              <button title={file.name} onClick={() => jump(i)}>
                {file.name}
              </button>
              <button
                aria-label={`Collapse ${i}`}
                onClick={() => {
                  setCollapsed(toggle(collapsed, file.name));
                  setRevision((v) => v + 1);
                }}
              >
                {collapsed.has(file.name) ? "+" : "−"}
              </button>
            </div>
          ))}
        </aside>
        <section className="review">
          <div className="toolbar">
            <span>
              {config.workers === "1" ? "4 workers" : "Main thread"} · {config.renderer} ·{" "}
              {findings.length} findings
            </span>
            <button onClick={() => replace(false, true)}>Replace naïvely</button>
            <button onClick={() => replace(true, true)}>Replace + reanchor</button>
            <button onClick={() => replace(false, false)}>Replace, same version</button>
          </div>
          <div className="notice">
            {replacement}
            {selection && (
              <button
                onClick={() => {
                  const id = `human-${findings.length}`;
                  setFindings((all) => [
                    ...all,
                    {
                      id,
                      file: selection.id,
                      line: selection.range.start,
                      side: selection.range.side === "deletions" ? "deletions" : "additions",
                      severity: "Info",
                      resolved: false,
                      replies: [],
                      draft: "",
                    },
                  ]);
                  setRevision((v) => v + 1);
                }}
              >
                Comment on {selection.range.side}:{selection.range.start}–{selection.range.end}
              </button>
            )}
          </div>
          {config.renderer === "codeview" ? (
            <CodeView
              ref={ref}
              className="diff-scroll"
              items={items}
              options={options}
              renderAnnotation={renderAnnotation}
              selectedLines={selection}
              onSelectedLinesChange={setSelection}
            />
          ) : config.renderer === "virtualizer" ? (
            <Virtualizer className="diff-scroll">
              {items.map((item, i) => (
                <div data-file-index={i} key={item.id}>
                  <FileDiff
                    fileDiff={item.fileDiff}
                    lineAnnotations={item.annotations}
                    options={{ ...options, collapsed: item.collapsed }}
                    renderAnnotation={renderAnnotation}
                  />
                </div>
              ))}
            </Virtualizer>
          ) : (
            <div className="diff-scroll plain">
              {items.map((item, i) => (
                <div data-file-index={i} key={item.id}>
                  <FileDiff
                    fileDiff={item.fileDiff}
                    lineAnnotations={item.annotations}
                    options={{ ...options, collapsed: item.collapsed }}
                    renderAnnotation={renderAnnotation}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}

async function boot() {
  const manifest = manifestSchema.parse(await (await fetch("/manifest.json")).json());
  if (!manifest.some((f) => f.id === config.fixture)) throw new Error("Unknown fixture");
  const fixture = fixtureSchema.parse(await (await fetch(`/${config.fixture}.json`)).json());
  const start = performance.now();
  const diffs =
    config.input === "contents"
      ? Object.entries(fixture.contents).map(([name, pair]) =>
          parseDiffFromFile(
            { name, contents: pair.old, cacheKey: `${fixture.sha256}:old:${name}` },
            { name, contents: pair.new, cacheKey: `${fixture.sha256}:new:${name}` },
          ),
        )
      : parsePatchFiles(fixture.patch, fixture.sha256, true).flatMap((p) => p.files);
  metrics.parseMs = performance.now() - start;
  metrics.fileCount = diffs.length;
  if (!diffs.length) throw new Error("No parsed files");
  mountedAt = performance.now();
  const app = <App fixture={fixture} initialDiffs={diffs} />;
  createRoot(document.getElementById("root")!).render(
    config.workers === "1" ? (
      <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
        {app}
      </WorkerPoolContextProvider>
    ) : (
      app
    ),
  );
}
boot().catch((error) => {
  errors.push(String(error));
  document.getElementById("root")!.textContent = String(error);
});
