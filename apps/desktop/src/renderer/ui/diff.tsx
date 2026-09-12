// The Changes and Review tabs. Pierre renders the patch; Loom owns the review shell — the file
// list, viewed state, jumps, and the findings in the annotation slots (spike 04).

import type { Finding, Task } from "@loom/core";
import type { CodeViewDiffItem, FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { PatchFileMeta } from "../fixtures/patch.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { taskFindings } from "../store/selectors.js";
import { severityTone, since } from "./format.js";

/** The patch is the same for every task in this shell, so parse it once. */
let parsed: FileDiffMetadata[] | null = null;

function parse(text: string, key: string): FileDiffMetadata[] {
  if (!parsed) {
    const files = parsePatchFiles(text, key, true).flatMap(
      (patch) => patch.files,
    );
    // An empty or unparseable patch is an error, never a clean review (spike 04).
    if (files.length === 0)
      throw new Error("The patch did not parse into any files");
    parsed = files;
  }
  return parsed;
}

export function DiffTab({
  task,
  withFindings,
}: {
  task: Task;
  withFindings: boolean;
}) {
  const store = useStoreApi();
  const patch = useStore((s) => s.snapshot.patch);
  const now = useStore((s) => s.snapshot.now);
  const theme = useStore((s) => s.ui.theme);
  const findings = useStore(
    (s) => (withFindings ? taskFindings(s.snapshot, task) : EMPTY_FINDINGS),
    shallowArray,
  );
  const comments = useStore((s) => s.snapshot.comments);
  const viewed = useStore((s) => s.snapshot.viewedFiles[task.id] ?? EMPTY);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const handle = useRef<CodeViewHandle<string, undefined>>(null);

  const files = useMemo(() => parse(patch.text, patch.key), [patch]);
  // Pierre reconciles an item only when its version changes, so bump it whenever the content
  // or the annotations on it change (spike 04).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependencies are the signal
  const version = useMemo(() => bump(), [findings, comments, theme]);

  const byFile = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const finding of findings) {
      const path = finding.location?.path ?? finding.anchor?.newPath;
      if (!path || finding.location?.startLine == null) continue;
      const list = map.get(path);
      if (list) list.push(finding);
      else map.set(path, [finding]);
    }
    return map;
  }, [findings]);

  const options = useMemo(
    () => ({
      theme: { dark: "github-dark", light: "github-light" } as const,
      themeType: theme,
      diffStyle: "split" as const,
      diffIndicators: "bars" as const,
      enableLineSelection: true,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      itemMetrics: { lineHeight: 20 },
      onPostRender: () => {
        window.loom.diffPaintedAt ??= performance.now();
      },
      // Application-owned CSS only; no fixture or patch text is interpolated here.
      unsafeCSS:
        ":host { --diffs-font-family: var(--mono); --diffs-font-size: 12px; --diffs-line-height: 20px; }",
      loadDiffFiles: async (file: FileDiffMetadata) => {
        const pair = patch.contents[file.name];
        if (!pair) throw new Error(`No full contents for ${file.name}`);
        return {
          oldFile: {
            name: file.name,
            contents: pair.old,
            cacheKey: `${patch.key}:old:${file.name}`,
          },
          newFile: {
            name: file.name,
            contents: pair.new,
            cacheKey: `${patch.key}:new:${file.name}`,
          },
        };
      },
    }),
    [patch, theme],
  );

  const items: CodeViewDiffItem<string>[] = useMemo(
    () =>
      files.map((fileDiff) => ({
        id: fileDiff.name,
        type: "diff",
        fileDiff,
        version,
        annotations: (byFile.get(fileDiff.name) ?? []).map((finding) => ({
          side: "additions" as const,
          lineNumber: finding.location?.startLine ?? 1,
          metadata: finding.id as string,
        })),
      })),
    [files, version, byFile],
  );

  /** Jump by path: the file list also holds files with no hunks, such as the binary one. */
  const jump = useCallback(
    (path: string) => {
      setActive(path);
      if (files.some((file) => file.name === path)) {
        handle.current?.scrollTo({ type: "item", id: path, align: "start" });
      }
    },
    [files],
  );

  const step = useCallback(
    (delta: number) => {
      const index = files.findIndex((file) => file.name === active);
      const next =
        files[Math.max(0, Math.min(files.length - 1, index + delta))];
      if (next) jump(next.name);
    },
    [files, active, jump],
  );

  const renderAnnotation = useCallback(
    (annotation: { metadata: string }) => {
      const finding = findings.find((item) => item.id === annotation.metadata);
      if (!finding) return null;
      const thread = comments.filter(
        (comment) => comment.findingId === finding.id,
      );
      return (
        <article
          className={`finding-card ${finding.severity}`}
          data-finding={finding.id}
        >
          <div className="finding-head">
            <span className={`chip ${severityTone(finding.severity)}`}>
              {finding.severity}
            </span>
            <span className="chip">{finding.status}</span>
            {finding.location?.status !== "exact" ? (
              <span className="chip attention">{finding.location?.status}</span>
            ) : null}
            <span className="faint">
              {finding.source} · round {finding.round} ·{" "}
              {since(now, finding.createdAt)} ago
            </span>
          </div>
          <strong>{finding.title}</strong>
          <div className="dim">{finding.body}</div>
          {thread.map((comment) => (
            <div className="comment" key={comment.id}>
              <div className="who">
                {comment.author} · {since(now, comment.at)} ago
              </div>
              <div>{comment.body}</div>
            </div>
          ))}
          <div className="reply">
            <input
              aria-label={`Reply to ${finding.id}`}
              placeholder="Reply…"
              value={draft[finding.id] ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  [finding.id]: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                store.addComment(finding.id, draft[finding.id] ?? "");
                setDraft((current) => ({ ...current, [finding.id]: "" }));
              }}
            />
            <button
              type="button"
              onClick={() => {
                store.addComment(finding.id, draft[finding.id] ?? "");
                setDraft((current) => ({ ...current, [finding.id]: "" }));
              }}
            >
              Reply
            </button>
            <button
              type="button"
              onClick={() =>
                store.setFindingStatus(
                  finding.id,
                  finding.status === "resolved" ? "open" : "resolved",
                )
              }
            >
              {finding.status === "resolved" ? "Reopen" : "Resolve"}
            </button>
          </div>
        </article>
      );
    },
    [findings, comments, draft, now, store],
  );

  return (
    <div className="review">
      <div className="file-list">
        {patch.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            active={active === file.path}
            viewed={viewed.includes(file.path)}
            findings={byFile.get(file.path)?.length ?? 0}
            onJump={() => jump(file.path)}
            onViewed={() => store.toggleViewed(task.id, file.path)}
          />
        ))}
      </div>
      <div className="diff-pane">
        <div className="terminal-bar">
          <span>
            {patch.files.length} files · {viewed.length} viewed
            {withFindings ? ` · ${findings.length} findings` : ""}
          </span>
          <span className="spacer" />
          <span>
            <kbd>alt</kbd> <kbd>↑</kbd>/<kbd>↓</kbd> next file
          </span>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a scroll container that also
            takes alt+arrow; every file is reachable from the file list above it. */}
        <div
          className="diff-scroll"
          onKeyDown={(event) => {
            if (!event.altKey) return;
            if (event.key === "ArrowDown") step(1);
            if (event.key === "ArrowUp") step(-1);
          }}
        >
          <CodeView
            ref={handle}
            className="diff-scroll"
            items={items}
            options={options}
            renderAnnotation={withFindings ? renderAnnotation : undefined}
          />
        </div>
      </div>
    </div>
  );
}

const EMPTY: string[] = [];
const EMPTY_FINDINGS: Finding[] = [];

let counter = 0;
function bump(): number {
  counter += 1;
  return counter;
}

function FileRow({
  file,
  active,
  viewed,
  findings,
  onJump,
  onViewed,
}: {
  file: PatchFileMeta;
  active: boolean;
  viewed: boolean;
  findings: number;
  onJump: () => void;
  onViewed: () => void;
}) {
  return (
    <div className="file-row" data-active={active} data-file={file.path}>
      <input
        type="checkbox"
        checked={viewed}
        onChange={onViewed}
        aria-label={`Viewed ${file.path}`}
      />
      <button type="button" className="path" title={file.path} onClick={onJump}>
        {file.path}
      </button>
      {file.status !== "modified" ? (
        <span className="chip">{file.status}</span>
      ) : null}
      {findings > 0 ? (
        <span className="chip attention nums">{findings}</span>
      ) : null}
      <span className="faint nums">
        +{file.added} −{file.deleted}
      </span>
    </div>
  );
}
