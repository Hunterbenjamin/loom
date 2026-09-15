import { KEYBINDING_ACTIONS } from "@loom/core";
import {
  formatBindings,
  type KeybindingsState,
} from "../../shared/keybindings.js";

export const ShortcutsHelp = ({
  bindings,
  close,
}: {
  bindings: KeybindingsState;
  close: () => void;
}) => (
  <div className="scrim">
    <div className="wb-help">
      <h2>Workbench shortcuts</h2>
      {KEYBINDING_ACTIONS.map((action) => (
        <p key={action.id}>
          <kbd>{formatBindings(bindings.config, action.id)}</kbd> {action.label}
        </p>
      ))}
      <p>
        Terminal scroll mode: j/k line, Ctrl+d/Ctrl+u half page, PageUp/PageDown
        page, gg/G top/bottom. Esc or q returns to the bottom and exits.
        Shift+PageUp/PageDown scroll a page in any mode.
      </p>
      <p>
        Prefix expires after {bindings.config.prefixTimeoutMs / 1000} seconds.
        Escape cancels. Modifier keys preserve the prefix; unknown suffixes pass
        through.
      </p>
      <p>
        {bindings.path
          ? `Edit ${bindings.path}; changes reload automatically.`
          : "Using default keybindings."}
      </p>
      <button type="button" onClick={close}>
        Close
      </button>
    </div>
  </div>
);
