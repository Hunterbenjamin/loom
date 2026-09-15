import type { Task } from "@loom/core";
import type { TaskDiff } from "@loom/protocol";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { useDetailScroller } from "./detail-layout.js";

/** Local branch changes before GitHub owns a PR diff. */
export function BranchDiff({ task }: { task: Task }) {
  const store = useStoreApi();
  const containerRef = useDetailScroller();
  const theme = useStore((s) => s.ui.theme);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: new task versions invalidate the local branch projection.
  useEffect(() => {
    let disposed = false;
    setDiff(null);
    setError("");
    void store
      .command({
        kind: "fetch_diff",
        taskId: task.id,
        range: { mode: "whole_branch" },
      })
      .then((ack) => {
        if (disposed) return;
        if (!ack.ok) setError(ack.error.message);
        else if (ack.result.kind === "diff") setDiff(ack.result.diff);
      })
      .catch((error: unknown) => {
        if (!disposed)
          setError(
            error instanceof Error
              ? error.message
              : "Could not read branch changes",
          );
      });
    return () => {
      disposed = true;
    };
  }, [store, task.id, task.version]);
  const items = useMemo(
    () =>
      diff
        ? parsePatchFiles(diff.patch.text, diff.patch.key)
            .flatMap((patch) => patch.files)
            .map((fileDiff) => ({
              type: "diff" as const,
              id: fileDiff.name,
              fileDiff,
            }))
        : [],
    [diff],
  );
  if (error)
    return (
      <div className="pad" role="alert">
        {error}
      </div>
    );
  if (!diff) return <div className="pad faint">Loading branch changes…</div>;
  if (!items.length) return <div className="pad faint">No branch changes.</div>;
  return (
    <CodeView
      containerRef={containerRef}
      className="pr-diff-cards"
      items={items}
      options={{
        diffStyle: "unified",
        theme: { dark: "github-dark", light: "github-light" },
        themeType: theme,
      }}
    />
  );
}
