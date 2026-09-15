import { useEffect, useRef } from "react";
import { useStore } from "../store/react.js";

import { formatKeys, trackerKeymap } from "./tracker-keymap.js";

export function TrackerHelp({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="create-issue-dialog"
      aria-labelledby="tracker-keys-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="tracker-keys-title">Tracker keyboard shortcuts</h2>
      <dl>
        {trackerKeymap.map((entry) => (
          <div key={entry.id} data-key-id={entry.id}>
            <dt>
              <strong>
                {entry.group}: {entry.label}
              </strong>
            </dt>
            <dd>{formatKeys(entry.id)}</dd>
          </div>
        ))}
      </dl>
      <p>
        All tracker keys, including ⌘Enter, pause in inputs, editors and
        terminals. Dialogs own their keys. Tab / Shift+Tab focus controls; Enter
        / Space activate them.
      </p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}

export function WhichKey() {
  const detail = useStore(
    (s) => !!(s.ui.openTask || s.ui.openPr || s.ui.openBrief),
  );
  const list = useStore((s) => s.ui.view !== "settings");
  return (
    <aside
      className="tracker-which-key"
      aria-label="Go to shortcuts"
      role="status"
    >
      <strong>g — Go to</strong>
      {trackerKeymap
        .filter(
          (entry) =>
            entry.keys.some((key) => key.startsWith("g ")) &&
            (entry.scope === "global" ||
              (detail
                ? entry.scope === "detail"
                : list && entry.scope === "list")),
        )
        .map((entry) => (
          <div key={entry.id}>
            <kbd>{formatKeys(entry.id)}</kbd> {entry.label}
          </div>
        ))}
      <small>Esc or another key cancels</small>
    </aside>
  );
}
