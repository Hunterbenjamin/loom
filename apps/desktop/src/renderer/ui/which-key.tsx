import { useKeybindingsConfig } from "../keybindings-context.js";
import { useStore } from "../store/react.js";
import { formatKeys, getTrackerKeymap } from "./tracker-keymap.js";

export function WhichKey({ leader }: { leader: string }) {
  const config = useKeybindingsConfig();
  const trackerKeymap = getTrackerKeymap(config);
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
      <strong>{leader} — Go to</strong>
      {trackerKeymap
        .filter(
          (entry) =>
            entry.keys.some((key) => key.startsWith(`${leader} `)) &&
            (entry.scope === "global" ||
              (detail
                ? entry.scope === "detail"
                : list && entry.scope === "list")),
        )
        .map((entry) => (
          <div key={entry.id}>
            <kbd>{formatKeys(entry.id, config)}</kbd> {entry.label}
          </div>
        ))}
      <small>Esc or another key cancels</small>
    </aside>
  );
}
