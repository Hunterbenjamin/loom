import type { TaskSize } from "@loom/core";
import { suggestName, type TaskId } from "@loom/core";
import type { AckOutcome } from "@loom/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";

function acknowledged(outcome: AckOutcome) {
  if (!outcome.ok) {
    throw new Error(
      [
        `${outcome.error.code}: ${outcome.error.message}`,
        ...outcome.error.details,
      ].join("\n"),
    );
  }
  return outcome.result;
}

export function CreateIssueDialog() {
  const store = useStoreApi();
  const repos = useStore((s) => s.snapshot.repos);
  const settings = useStore((s) => s.settings);
  const [sidebarRepo] = useState(() => store.getState().ui.repo);
  const initialRepo =
    repos.find((r) => r.id === sidebarRepo)?.id ?? repos[0]?.id ?? "";
  const [chosenRepo, setRepoId] = useState<string | null>(null);
  const repoId = chosenRepo ?? initialRepo;
  const defaultsFor = (id: string) =>
    settings.find((item) => item.id === `repo:${id}`)?.effective.workflow ??
    settings.find((item) => item.id === "global")?.effective.workflow;
  const initialDefaults = defaultsFor(initialRepo);
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const nameEdited = useRef(false);
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"backlog" | "todo">("backlog");
  const [size, setSize] = useState<TaskSize>(initialDefaults?.size ?? "normal");
  const [requirePlanApproval, setRequirePlanApproval] = useState(
    initialDefaults?.requirePlanApproval ?? true,
  );
  const [budgetMinutes, setBudgetMinutes] = useState<number | null>(
    initialDefaults?.budgetMinutes ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  // A rejected Todo request can be retried without creating another backlog issue.
  const [created, setCreated] = useState<TaskId | null>(null);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const dirty =
    title !== "" ||
    name !== "" ||
    description !== "" ||
    repoId !== initialRepo ||
    status !== "backlog" ||
    size !== (initialDefaults?.size ?? "normal") ||
    requirePlanApproval !== (initialDefaults?.requirePlanApproval ?? true) ||
    budgetMinutes !== (initialDefaults?.budgetMinutes ?? null);
  const valid =
    title.trim().length > 0 &&
    title.trim().length <= 200 &&
    description.length <= 20000 &&
    repos.some((r) => r.id === repoId);

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize after the controlled text changes.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [description]);
  useEffect(() => {
    if (discard) keepEditing.current?.focus();
    else input.current?.focus();
  }, [discard]);

  const finish = async (id: TaskId, todo: boolean) => {
    if (store.getState().ui.repo !== repoId) await store.setRepo(repoId);
    store.selectCreatedTask(id, todo);
  };
  const cancel = () => {
    if (submitting.current) return;
    if (created)
      void finish(created, false).catch((error: unknown) =>
        setError(
          error instanceof Error
            ? error.message
            : "Could not select repository",
        ),
      );
    else if (dirty) setDiscard(true);
    else store.setCreate(null);
  };
  const submit = async () => {
    if (!valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      let id = created;
      if (!id) {
        const repo = repos.find((r) => r.id === repoId);
        if (!repo) throw new Error("Select a repository.");
        const result = acknowledged(
          await store.command({
            kind: "create_task",
            repoId: repo.id,
            title: title.trim(),
            name: name.trim() || null,
            description,
            summary: null,
            providers: null,
            requirePlanApproval,
            blockedBy: [],
            budgetMinutes,
            size,
          }),
        );
        if (result.kind !== "task_created")
          throw new Error("Expected an issue creation acknowledgement.");
        id = result.taskId;
        if (!id) throw new Error("The issue could not be created.");
        setCreated(id);
      }
      if (status === "todo") {
        const result = acknowledged(
          await store.command({
            kind: "human",
            taskId: id,
            command: { type: "move", to: "todo" },
          }),
        );
        if (result.kind !== "human")
          throw new Error("Expected a workflow acknowledgement.");
      }
      await finish(id, status === "todo");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="create-dialog"
      aria-labelledby="create-issue-title"
      onCancel={(e) => {
        e.preventDefault();
        if (discard) {
          setDiscard(false);
          input.current?.focus();
        } else cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key === "Enter" &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            if (!discard) e.currentTarget.requestSubmit();
          }
        }}
      >
        <h2 id="create-issue-title">Create issue</h2>
        <fieldset disabled={busy || !!created || discard}>
          <label htmlFor="issue-title">Title</label>
          <input
            ref={input}
            id="issue-title"
            required
            maxLength={200}
            autoComplete="off"
            placeholder="Issue title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!nameEdited.current) setName(suggestName(e.target.value));
            }}
          />
          <label htmlFor="issue-name">Name</label>
          <input
            id="issue-name"
            maxLength={32}
            autoComplete="off"
            placeholder="Short issue name"
            value={name}
            onChange={(e) => {
              nameEdited.current = true;
              setName(e.target.value);
            }}
          />
          <label htmlFor="issue-description">
            Description <span className="faint">· Markdown supported</span>
          </label>
          <textarea
            ref={textarea}
            id="issue-description"
            rows={4}
            maxLength={20000}
            placeholder="Add details…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="issue-fields">
            <div>
              <label htmlFor="issue-repo">Repository</label>
              <select
                id="issue-repo"
                required
                value={repoId}
                onChange={(e) => {
                  const id = e.target.value;
                  setRepoId(id);
                  const next = defaultsFor(id);
                  if (next) {
                    setSize(next.size);
                    setRequirePlanApproval(next.requirePlanApproval);
                    setBudgetMinutes(next.budgetMinutes);
                  }
                }}
              >
                {!repos.some((r) => r.id === repoId) && (
                  <option value="">Select a repository</option>
                )}
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.github}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="issue-status">Status</label>
              <select
                id="issue-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="backlog">Backlog</option>
                <option value="todo">Todo — starts the workflow</option>
              </select>
            </div>
            <div>
              <label htmlFor="issue-size">Size</label>
              <select
                id="issue-size"
                value={size}
                aria-describedby="issue-size-hint"
                onChange={(e) => setSize(e.target.value as typeof size)}
              >
                <option value="normal">Normal</option>
                <option value="small">Small</option>
              </select>
            </div>
            <div>
              <label htmlFor="issue-budget">Budget (minutes)</label>
              <input
                id="issue-budget"
                type="number"
                min="1"
                placeholder="No limit"
                value={budgetMinutes ?? ""}
                onChange={(e) =>
                  setBudgetMinutes(
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              />
            </div>
          </div>
          <p id="issue-size-hint" className="faint">
            Small skips planning, for one-file fixes.
          </p>
          <label className="issue-toggle" htmlFor="issue-plan-approval">
            <input
              id="issue-plan-approval"
              type="checkbox"
              checked={requirePlanApproval}
              onChange={(e) => setRequirePlanApproval(e.target.checked)}
            />
            Require plan approval
          </label>
        </fieldset>
        {repos.length === 0 && (
          <p role="status">
            No repositories available. Add a repository before creating an
            issue.
          </p>
        )}
        {created && error && (
          <p>
            {created} was created. The workflow start was not acknowledged;
            retry it or close.
          </p>
        )}
        {error && (
          <p role="alert" className="create-error">
            {error}
          </p>
        )}
        {discard ? (
          <>
            <p role="alert">Discard this issue draft?</p>
            <div className="create-actions">
              <button
                ref={keepEditing}
                type="button"
                onClick={() => {
                  setDiscard(false);
                  input.current?.focus();
                }}
              >
                Keep editing
              </button>
              <button type="button" onClick={() => store.setCreate(null)}>
                Discard draft
              </button>
            </div>
          </>
        ) : (
          <div className="create-actions">
            <span className="faint">⌘Enter to submit</span>
            <span className="spacer" />
            <button type="button" disabled={busy} onClick={cancel}>
              {created ? "Close" : "Cancel"}
            </button>
            <button type="submit" disabled={!valid || busy}>
              {busy
                ? "Creating…"
                : created
                  ? "Retry workflow start"
                  : "Create issue"}
            </button>
          </div>
        )}
      </form>
    </dialog>
  );
}
