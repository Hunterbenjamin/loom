import { useEffect, useRef } from "react";

export const TRACKER_KEYS = [
  [
    "Navigation",
    "g a · Issues; g n · Inbox; g r · Review; g d · Daily brief; g s · Settings",
  ],
  ["View", "g i · List; g b · Board (preserves the current section)"],
  [
    "Lists, Inbox and briefs",
    "j / k · Next / previous row; Enter · Open; / · Review filter",
  ],
  [
    "Board",
    "h / l · Previous / next populated column; j / k · Card in column; Enter · Open",
  ],
  ["Issues", "c · Create; e · Move selected or open issue (Backlog / Todo)"],
  [
    "Detail tabs",
    "1 · Overview; 2 · Plan; 3 · Diff; 4 · Terminal (when available)",
  ],
  [
    "Issue detail",
    "a · Approve plan / merge; A · Change plan / request changes; E · Edit; t · Move to Todo",
  ],
  [
    "Reading details",
    "j / k · Scroll; Shift+J / Shift+K · Half page; g g · Top; G · Bottom; z · Toggle earlier activity; f · Toggle findings; F · Fullscreen",
  ],
  [
    "Pull requests",
    "m or ⌘Enter · Merge; d · Delete branch; o · Open on GitHub; r · Refresh",
  ],
  [
    "Everywhere",
    "? · This map; ⌘K / Ctrl+K · Command palette; Esc · Close overlay or detail",
  ],
  [
    "Other controls",
    "Tab / Shift+Tab · Focus controls, menus, settings and links; Enter / Space · Activate. F6 returns focus from terminal input to detail controls.",
  ],
  [
    "Typing",
    "Tracker shortcuts pause in inputs, editors and terminals. Dialogs handle their own keys.",
  ],
] as const;

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
        {TRACKER_KEYS.map(([label, keys]) => (
          <div key={label}>
            <dt>
              <strong>{label}</strong>
            </dt>
            <dd>{keys}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
