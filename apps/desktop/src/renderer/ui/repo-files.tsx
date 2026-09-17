import type { RepoFiles } from "@loom/protocol";
import { useEffect, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";

export function RepositoryFiles({ repoId }: { repoId: string }) {
  const store = useStoreApi();
  const repoName = useStore(
    (state) =>
      state.snapshot.repos.find((repo) => repo.id === repoId)?.github ?? repoId,
  );
  const [files, setFiles] = useState<RepoFiles | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [created, setCreated] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-check explicitly invalidates the disk projection.
  useEffect(() => {
    let active = true;
    setFiles(null);
    setError("");
    setCreated(false);
    setBusy(true);
    void store
      .checkRepoFiles(repoId)
      .then(
        (result) => {
          if (active) setFiles(result);
        },
        (error: unknown) => {
          if (active) setError(String(error));
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [store, repoId, revision]);
  return (
    <section className="pad repo-files" aria-label="Repository files">
      <h3>Repository files</h3>
      <p>{repoName}</p>
      {files ? (
        <ul>
          {files.map(({ file, status, reason }) => (
            <li key={file}>
              <code>{file}</code>: {status}
              {reason ? ` — ${reason}` : ""}
            </li>
          ))}
        </ul>
      ) : busy ? (
        <p>Checking repository files…</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => setRevision((value) => value + 1)}
      >
        Re-check
      </button>
      {files?.some((file) => file.status !== "present") && !created ? (
        <>
          <p>
            Draft the missing or unusable files as a pull request for you to
            review and merge.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await store.startRepoOnboarding(repoId);
                setCreated(true);
              } catch (error) {
                setError(String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            Draft files as a PR
          </button>
        </>
      ) : null}
      {created ? <p>Drafting issue created.</p> : null}
    </section>
  );
}
