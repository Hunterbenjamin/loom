import type {
  PullRequestDetailRow,
  pullRequestCommitDiff,
} from "@loom/protocol";
import { fileId, isoTime } from "@loom/protocol";
import {
  type CodeViewItem,
  type FileDiffMetadata,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { useStore, useStoreApi } from "../store/react.js";
import { since } from "./format.js";
import { ChangeCounts, groupPrFiles } from "./pull-request-overview.js";

type CommitDiff = z.output<typeof pullRequestCommitDiff>;
type File = PullRequestDetailRow["detail"]["files"][number];
let revision = 0;

/** A capped patch's last file can be cut mid-hunk; never present it as complete. */
function parsePrPatch(patch: NonNullable<PullRequestDetailRow["patch"]>) {
  const last = patch.patch.lastIndexOf("\ndiff --git ");
  const text = patch.truncated
    ? last < 0
      ? ""
      : patch.patch.slice(0, last + 1)
    : patch.patch;
  if (!text.startsWith("diff --git ")) return [];
  return parsePatchFiles(
    text,
    `${patch.baseSha}:${patch.headSha}:${++revision}`,
    true,
  ).flatMap((p) => p.files);
}

export function PullRequestDiff({
  row,
  selectedFile,
}: {
  row: PullRequestDetailRow;
  selectedFile?: string | null;
}) {
  // A new PR/head discards every transient selection and in-flight result.
  return (
    <DiffContent
      key={`${row.repoId}:${row.number}:${row.detail.headSha}:${row.detail.baseSha}`}
      row={row}
      selectedFile={selectedFile}
    />
  );
}
function DiffContent({
  row,
  selectedFile,
}: {
  row: PullRequestDetailRow;
  selectedFile?: string | null;
}) {
  const store = useStoreApi();
  const theme = useStore((s) => s.ui.theme);
  const now = useStore((s) => s.snapshot.now);
  const disconnected = useStore((s) => s.live && s.connection !== "connected");
  const [tab, setTab] = useState<"files" | "commits">("files");
  const [commitSha, setCommitSha] = useState<
    PullRequestDetailRow["detail"]["headSha"] | null
  >(null);
  const [commit, setCommit] = useState<CommitDiff | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [error, setError] = useState("");
  const [split, setSplit] = useState(false);
  const [whitespace, setWhitespace] = useState(false);
  const [filtered, setFiltered] = useState<Map<
    string,
    FileDiffMetadata | null
  > | null>(null);
  const [active, setActive] = useState<string | null>(selectedFile ?? null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const handle = useRef<CodeViewHandle<undefined, undefined>>(null);
  const hunkCursor = useRef(-1);
  const selectionVersion = useRef(0);
  const pr = row.detail;
  const selection = useMemo(
    () => ({
      repoId: row.repoId,
      number: row.number,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    }),
    [row.repoId, row.number, pr.headSha, pr.baseSha],
  );
  const patch = commitSha ? commit?.patch : row.patch;
  const files = useMemo(
    () =>
      groupPrFiles(commitSha ? (commit?.files ?? []) : pr.files).flatMap(
        (g) => g.files,
      ),
    [commitSha, commit, pr.files],
  );
  const parsed = useMemo(() => {
    try {
      const files = patch ? parsePrPatch(patch) : [];
      return {
        files,
        error:
          patch && !files.length
            ? "No complete file diff is available. Open on GitHub to inspect it."
            : "",
      };
    } catch {
      return {
        files: [],
        error: "Could not parse the diff. Open on GitHub to inspect it.",
      };
    }
  }, [patch]);
  const viewed = useMemo(
    () =>
      new Set(
        row.viewedFiles
          .filter((f) => f.headSha === pr.headSha)
          .map((f) => f.path),
      ),
    [row.viewedFiles, pr.headSha],
  );
  const load = useCallback(
    async (path: string, ignoreWhitespace: boolean) => {
      const result = await store.command({
        kind: "fetch_pull_request_file",
        ...selection,
        commitSha,
        path,
        ignoreWhitespace,
      });
      if (!result.ok) throw new Error(result.error.message);
      if (result.result.kind !== "pull_request_file")
        throw new Error("Unexpected file response");
      return result.result.contents;
    },
    [store, selection, commitSha],
  );

  useEffect(() => {
    setFiltered(null);
    if (!whitespace) return;
    let cancelled = false;
    setError("");
    // Keep owner reads bounded even when a large PR has hundreds of files.
    const pending = [...files];
    const values = new Map<string, FileDiffMetadata | null>();
    async function work() {
      while (!cancelled) {
        const file = pending.shift();
        if (!file) return;
        const contents = await load(file.path, true);
        const parsed = parsePatchFiles(
          contents.patch,
          `${selection.headSha}:${file.path}:whitespace`,
          true,
        ).flatMap((p) => p.files)[0];
        values.set(file.path, parsed?.hunks.length ? parsed : null);
      }
    }
    void Promise.all([work(), work()])
      .then(() => {
        if (!cancelled) setFiltered(values);
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not hide whitespace: ${e.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [whitespace, files, load, selection.headSha]);

  const items = useMemo(
    (): CodeViewItem<undefined>[] =>
      files.map((file) => {
        const diff = whitespace
          ? filtered?.get(file.path)
          : parsed.files.find((d) => d.name === file.path);
        const base = {
          id: file.path,
          version: ++revision,
          collapsed: !commitSha && viewed.has(file.path),
        };
        if (diff) return { ...base, type: "diff", fileDiff: diff };
        return {
          ...base,
          type: "file",
          file: {
            name: file.path,
            contents:
              whitespace && filtered?.has(file.path)
                ? "No changes apart from whitespace.\n"
                : "No complete text diff available. This file may be binary, unchanged by a rename, or omitted from the patch. Open on GitHub to inspect it.\n",
            lang: "text",
          },
        };
      }),
    [files, whitespace, filtered, parsed.files, viewed, commitSha],
  );

  const jump = useCallback((path: string) => {
    setActive(path);
    hunkCursor.current = -1;
    handle.current?.scrollTo({ type: "item", id: path, align: "start" });
  }, []);
  useEffect(() => {
    if (selectedFile && patch) jump(selectedFile);
  }, [selectedFile, jump, patch]);

  const toggle = useCallback(
    async (path: string) => {
      if (disconnected || commitSha || inFlight.current.has(path)) return;
      inFlight.current.add(path);
      setBusy(new Set(inFlight.current));
      setError("");
      try {
        const result = await store.command({
          kind: "save_review_state",
          repoId: row.repoId,
          number: row.number,
          change: {
            headSha: pr.headSha,
            ...(viewed.has(path)
              ? { unviewed: [fileId.parse(path)] }
              : {
                  viewed: [
                    {
                      fileId: fileId.parse(path),
                      path,
                      headSha: pr.headSha,
                      at: isoTime.parse(new Date().toISOString()),
                    },
                  ],
                }),
          },
        });
        if (!result.ok) setError(result.error.message);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Could not save Reviewed state",
        );
      } finally {
        inFlight.current.delete(path);
        setBusy(new Set(inFlight.current));
      }
    },
    [
      disconnected,
      commitSha,
      store,
      row.repoId,
      row.number,
      pr.headSha,
      viewed,
    ],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.composedPath()[0];
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.repeat ||
        document.querySelector("dialog[open], [cmdk-root]") ||
        (target instanceof HTMLElement &&
          (target.matches("input, textarea, select") ||
            target.isContentEditable)) ||
        (tab === "commits" && !commitSha)
      )
        return;
      const path = active ?? files[0]?.path;
      if (!path) return;
      if (event.key === "j" || event.key === "k") {
        const index = files.findIndex((f) => f.path === path);
        const next =
          files[
            Math.max(
              0,
              Math.min(files.length - 1, index + (event.key === "j" ? 1 : -1)),
            )
          ];
        if (next) jump(next.path);
      } else if (event.key === "v") void toggle(path);
      else if (event.key === "[" || event.key === "]") {
        const item = items.find((i) => i.id === path);
        if (item?.type !== "diff" || item.collapsed) return;
        hunkCursor.current = Math.max(
          0,
          Math.min(
            item.fileDiff.hunks.length - 1,
            hunkCursor.current + (event.key === "]" ? 1 : -1),
          ),
        );
        const hunk = item.fileDiff.hunks[hunkCursor.current];
        if (hunk)
          handle.current?.scrollTo({
            type: "line",
            id: path,
            lineNumber: Math.max(
              1,
              hunk.additionCount ? hunk.additionStart : hunk.deletionStart,
            ),
            side: hunk.additionCount ? "additions" : "deletions",
            align: "start",
          });
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [active, files, items, jump, toggle, tab, commitSha]);

  async function selectCommit(sha: PullRequestDetailRow["detail"]["headSha"]) {
    const version = ++selectionVersion.current;
    setCommitSha(sha);
    setCommit(null);
    setCommitLoading(true);
    setError("");
    setActive(null);
    try {
      const ack = await store.command({
        kind: "fetch_pull_request_commit",
        ...selection,
        commitSha: sha,
      });
      if (version !== selectionVersion.current) return;
      if (!ack.ok) throw new Error(ack.error.message);
      if (ack.result.kind !== "pull_request_commit")
        throw new Error("Unexpected commit response");
      setCommit(ack.result.diff);
    } catch (e) {
      if (version === selectionVersion.current)
        setError(e instanceof Error ? e.message : "Could not load commit");
    } finally {
      if (version === selectionVersion.current) setCommitLoading(false);
    }
  }
  const options = useMemo(
    () => ({
      theme: { dark: "github-dark", light: "github-light" } as const,
      themeType: theme,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      diffIndicators: "bars" as const,
      enableLineSelection: false,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      expandUnchanged: false,
      onPostRender: (node: HTMLElement) => {
        // Keep Pierre's native expansion controls; only its stock label differs from the reference.
        for (const label of node.shadowRoot?.querySelectorAll(
          "[data-unmodified-lines]",
        ) ?? []) {
          const text = label.textContent ?? "";
          if (/^\d+ unmodified lines$/.test(text))
            label.textContent = text.replace("unmodified", "unchanged");
        }
      },
      itemMetrics: { lineHeight: 20, diffHeaderHeight: 44 },
      layout: { gap: 10, paddingTop: 0, paddingBottom: 0 },
      loadDiffFiles: async (file: FileDiffMetadata) => {
        try {
          const contents = await load(file.name, whitespace);
          return {
            oldFile:
              file.type === "rename-pure"
                ? null
                : {
                    name: file.prevName ?? file.name,
                    contents: contents.old,
                  },
            newFile: { name: file.name, contents: contents.new },
          };
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not expand unchanged lines",
          );
          throw e;
        }
      },
      unsafeCSS:
        ":host { --diffs-font-family: var(--mono); --diffs-font-size: 12px; --diffs-line-height: 20px; border: 1px solid var(--line); border-radius: 8px; --diffs-dark-bg: var(--bg-raised); --diffs-light-bg: var(--bg-raised); --diffs-bg: var(--bg-raised); } [data-separator], [data-separator-wrapper] { background: var(--bg-raised); border-radius: 0; }",
    }),
    [theme, split, load, whitespace],
  );

  function header(item: CodeViewItem<undefined>) {
    const file = files.find((f) => f.path === item.id);
    if (!file) return null;
    return (
      <FileHeader
        file={file}
        active={active === file.path}
        reviewed={!commitSha && viewed.has(file.path)}
        disabled={disconnected || busy.has(file.path) || !!commitSha}
        onSelect={() => {
          setActive(file.path);
          hunkCursor.current = -1;
        }}
        onReviewed={() => void toggle(file.path)}
        url={pr.url}
      />
    );
  }
  const loading =
    commitLoading ||
    (!commitSha && row.patchLoading) ||
    (whitespace && !filtered && !error);
  return (
    <div className="pr-diff">
      <div className="pr-diff-bar">
        <div role="tablist" aria-label="Diff range">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            onClick={() => {
              selectionVersion.current++;
              setTab("files");
              setCommitSha(null);
              setCommit(null);
              setCommitLoading(false);
              setError("");
            }}
          >
            ☷ Files <span className="faint nums">{pr.changedFiles}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "commits"}
            onClick={() => setTab("commits")}
          >
            ⊙ Commits <span className="faint nums">{pr.commits.length}</span>
          </button>
        </div>
        <span className="spacer" />
        <details className="pr-menu">
          <summary aria-label="Diff settings">☷</summary>
          <div className="pr-menu-items">
            <label>
              Layout{" "}
              <select
                aria-label="Diff layout"
                value={split ? "split" : "unified"}
                onChange={(e) => setSplit(e.target.value === "split")}
              >
                <option value="unified">Unified</option>
                <option value="split">Split</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={whitespace}
                onChange={(e) => setWhitespace(e.target.checked)}
              />
              Hide whitespace changes
            </label>
          </div>
        </details>
      </div>
      {tab === "commits" ? (
        <section className="pr-diff-commits" aria-label="Commits">
          {pr.commits.map((c) => (
            <button
              key={c.sha}
              type="button"
              aria-pressed={commitSha === c.sha}
              onClick={() => void selectCommit(c.sha)}
            >
              <span>{c.message.split("\n")[0]}</span>
              <span className="faint">
                {c.author ?? "Unknown author"} ·{" "}
                {c.committedAt
                  ? `${since(now, c.committedAt)} ago`
                  : "Unknown age"}{" "}
                · {c.sha.slice(0, 7)}
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {error || parsed.error || (!commitSha && row.patchError) ? (
        <div role="alert" className="pad">
          {error || parsed.error || row.patchError}
        </div>
      ) : null}
      {loading ? (
        <div role="status" className="pad faint">
          Loading {whitespace ? "diff without whitespace changes" : "diff"}…
        </div>
      ) : null}
      {patch?.truncated ? (
        <div role="alert" className="pad attention">
          This patch exceeds 8 MiB and is truncated. The final incomplete file
          is omitted. Open on GitHub for the full diff.
        </div>
      ) : null}
      {!loading && (tab === "files" || commit) ? (
        <CodeView
          ref={handle}
          className="pr-diff-cards"
          items={items}
          options={options}
          renderCustomHeader={header}
        />
      ) : null}
    </div>
  );
}
function FileHeader({
  file,
  active,
  reviewed,
  disabled,
  onSelect,
  onReviewed,
  url,
}: {
  file: File;
  active: boolean;
  reviewed: boolean;
  disabled: boolean;
  onSelect(): void;
  onReviewed(): void;
  url: string;
}) {
  const slash = file.path.lastIndexOf("/");
  return (
    <div
      className="pr-diff-file-head"
      data-active={active}
      data-file={file.path}
    >
      <button
        type="button"
        className="pr-diff-file-name"
        title={file.path}
        onClick={onSelect}
      >
        <span className="faint">▧</span> {file.path.slice(slash + 1)}{" "}
        <span className="faint">{file.path.slice(0, slash + 1)}</span>
      </button>
      <ChangeCounts {...file} />
      <label
        title={
          disabled
            ? "Reviewed marks apply to the whole PR at its current head"
            : undefined
        }
      >
        <input
          type="checkbox"
          aria-label={`Reviewed ${file.path}`}
          checked={reviewed}
          disabled={disabled}
          onChange={onReviewed}
        />
        Reviewed
      </label>
      <details className="pr-menu">
        <summary aria-label={`More actions for ${file.path}`}>•••</summary>
        <div className="pr-menu-items">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(file.path)}
          >
            Copy file path
          </button>
          <a href={`${url}/files`} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        </div>
      </details>
    </div>
  );
}
