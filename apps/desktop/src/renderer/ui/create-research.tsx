import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";

export function CreateResearchDialog() {
  const store = useStoreApi();
  const connected = useStore((s) => s.connection === "connected");
  const [initialDirectory] = useState(() => {
    const { snapshot, ui } = store.getState();
    return snapshot.repos.find((repo) => repo.id === ui.repo)?.root ?? "";
  });
  const [directory, setDirectory] = useState(initialDirectory);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const valid =
    connected &&
    !!directory.trim() &&
    !!question.trim() &&
    question.length <= 10000;
  const dirty = directory !== initialDirectory || question !== "";

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
  useEffect(() => {
    if (discard) keepEditing.current?.focus();
    else input.current?.focus();
  }, [discard]);

  const cancel = () => {
    if (submitting.current) return;
    if (dirty) setDiscard(true);
    else store.setCreate(null);
  };
  const submit = async () => {
    if (!valid || discard || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const outcome = await store.command({
        kind: "start_research",
        id: crypto.randomUUID(),
        directory: directory.trim(),
        question: question.trim(),
      });
      if (!outcome.ok) throw new Error(outcome.error.message);
      if (outcome.result.kind !== "research_entry")
        throw new Error("Expected a research creation acknowledgement.");
      store.setCreate(null);
      store.setView("research");
      store.openResearch(outcome.result.entry.id);
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
      aria-labelledby="create-research-title"
      onCancel={(event) => {
        event.preventDefault();
        if (discard) setDiscard(false);
        else cancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (!discard) event.currentTarget.requestSubmit();
          }
        }}
      >
        <h2 id="create-research-title">Create research</h2>
        <fieldset disabled={busy || discard}>
          <label htmlFor="research-directory">Directory</label>
          <input
            id="research-directory"
            required
            autoComplete="off"
            placeholder="Absolute directory to read"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <label htmlFor="research-question">Question</label>
          <textarea
            ref={input}
            id="research-question"
            required
            rows={4}
            maxLength={10000}
            placeholder="What would you like to research?"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </fieldset>
        {!connected && <p role="status">Waiting for the coordinator…</p>}
        {error && (
          <p role="alert" className="create-error">
            {error}
          </p>
        )}
        {discard ? (
          <>
            <p role="alert">Discard this research draft?</p>
            <div className="create-actions">
              <button
                ref={keepEditing}
                type="button"
                onClick={() => setDiscard(false)}
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
              Cancel
            </button>
            <button type="submit" disabled={!valid || busy}>
              {busy ? "Creating…" : "Create research"}
            </button>
          </div>
        )}
      </form>
    </dialog>
  );
}
