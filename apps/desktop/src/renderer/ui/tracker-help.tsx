import { useEffect, useRef } from "react";
import { useStore } from "../store/react.js";

import { formatKeys, trackerKeymap } from "./tracker-keymap.js";

export function TrackerHelp({ onClose }: { onClose(): void }) {
  const body = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    body.current?.focus({ preventScroll: true });
    if (body.current) body.current.scrollTop = 0;
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="tracker-help"
      aria-labelledby="tracker-keys-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="tracker-keys-title">Tracker keyboard shortcuts</h2>
      <div className="tracker-help-body" ref={body} tabIndex={-1}>
        <div className="tracker-help-grid">
          {[...new Set(trackerKeymap.map((entry) => entry.group))].map(
            (group) => (
              <section key={group}>
                <h3>{group}</h3>
                <dl>
                  {trackerKeymap
                    .filter((entry) => entry.group === group)
                    .map((entry) => (
                      <div key={entry.id} data-key-id={entry.id}>
                        <dt>{entry.label}</dt>
                        <dd>
                          <kbd>{formatKeys(entry.id)}</kbd>
                        </dd>
                      </div>
                    ))}
                </dl>
              </section>
            ),
          )}
        </div>
        <p>
          Reading page shortcuts work while typing. Other tracker keys pause in
          inputs, editors and terminals. Dialogs own their keys. Tab / Shift+Tab
          focus controls; Enter / Space activate them.
        </p>
      </div>
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
