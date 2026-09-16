import { useStore } from "../store/react.js";
import { formatKeys, trackerKeymap } from "./tracker-keymap.js";

export function WhichKey() {
  const detail = useStore(
    (s) =>
      !!(s.ui.openTask || s.ui.openPr || s.ui.openBrief || s.ui.openResearch),
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
