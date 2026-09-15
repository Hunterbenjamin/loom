import type { Task } from "@loom/core";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/react.js";
import { useHumanCommand } from "./use-human-command.js";

export function EditBacklogIssue({
  task,
  onClose,
}: {
  task: Task;
  onClose(): void;
}) {
  const [version] = useState(task.version);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [size, setSize] = useState(task.size);
  const [requirePlanApproval, setRequirePlanApproval] = useState(
    task.requirePlanApproval,
  );
  const { send, submitting, outcome } = useHumanCommand(task.id);
  const connected = useStore((s) => !s.live || s.connection === "connected");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const changed = task.stage !== "backlog" || task.version !== version;
  return (
    <dialog
      ref={dialog}
      className="create-issue-dialog pr-confirm backlog-editor"
      aria-label="Edit backlog issue"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (changed || !connected || submitting || !title.trim()) return;
          const result = await send({
            type: "edit_task",
            expectedVersion: version,
            title: title.trim(),
            description,
            size,
            requirePlanApproval,
          });
          if (result?.kind === "queued" || result?.kind === "applied")
            onClose();
        }}
      >
        <h2>Edit issue</h2>
        <label>
          Title
          <input
            aria-label="Title"
            value={title}
            maxLength={200}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            aria-label="Description"
            value={description}
            maxLength={20000}
            rows={8}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          Size
          <select
            aria-label="Size"
            value={size}
            onChange={(event) => setSize(event.target.value as Task["size"])}
          >
            <option value="normal">Normal</option>
            <option value="small">Small</option>
          </select>
        </label>
        <label className="issue-toggle">
          <input
            type="checkbox"
            checked={requirePlanApproval}
            onChange={(event) => setRequirePlanApproval(event.target.checked)}
          />
          Require plan approval
        </label>
        {changed ? (
          <p role="alert">
            This issue changed. Reopen the editor before saving.
          </p>
        ) : null}
        {outcome.kind === "refused" ? (
          <p role="alert">{outcome.message}</p>
        ) : null}
        <div className="pr-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={changed || !connected || submitting || !title.trim()}
          >
            Save changes
          </button>
        </div>
      </form>
    </dialog>
  );
}
