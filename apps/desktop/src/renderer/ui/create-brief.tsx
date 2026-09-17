import { useEffect, useRef } from "react";
import { useBriefState } from "../store/brief-state.js";
import { useStoreApi } from "../store/react.js";

export function CreateBriefDialog() {
  const store = useStoreApi();
  const { state, busy, error, act } = useBriefState();
  const dialog = useRef<HTMLDialogElement>(null);
  const running = state?.runs.some((run) => run.status === "running");
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
  const close = () => store.setCreate(null);
  return (
    <dialog
      ref={dialog}
      className="create-dialog"
      aria-labelledby="create-brief-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (state && !busy && !running)
            void act({ kind: "run_brief", id: crypto.randomUUID() });
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <h2 id="create-brief-title">Create daily brief</h2>
        <p>
          Research live sources for a daily brief. You can close this dialog;
          the coordinator saves the brief when it finishes.
        </p>
        {running ? (
          <p role="status">Researching…</p>
        ) : !state ? (
          <p role="status">Loading briefs…</p>
        ) : null}
        {error ? (
          <p className="create-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="create-actions">
          <span className="faint">⌘Enter to run</span>
          <span className="spacer" />
          <button type="button" onClick={close}>
            Close
          </button>
          <button type="submit" disabled={!state || busy || running}>
            {busy || running ? "Researching…" : "Run now"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
