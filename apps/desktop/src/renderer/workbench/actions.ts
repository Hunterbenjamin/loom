import {
  bindingChord,
  isPrefixBinding,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
  type KeyStroke,
  matchesChord,
} from "@loom/core";
import type { KeybindingsConfig } from "../../shared/keybindings.js";

export {
  KEYBINDING_ACTIONS,
  type KeybindingAction,
} from "@loom/core";

type KeyEvent = KeyStroke & {
  type: string;
  repeat?: boolean;
  isComposing?: boolean;
};
/** One matcher per Workbench window; modifier presses must not cancel sequences. */
export function bindingMatcher(
  config: KeybindingsConfig,
  dispatch: (action: KeybindingAction) => void,
  armed: (value: boolean) => void,
  now = Date.now,
) {
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    if (until) armed(false);
    until = 0;
  };
  const handle = (event: KeyEvent): boolean => {
    if (event.type !== "keydown" || event.isComposing) return false;
    if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(event.key))
      return false;
    if (until && now() >= until) cancel();
    // Holding the prefix must not send a literal or consume the following action.
    if (event.repeat) return !!until || usesDirect(event);
    if (until) {
      cancel();
      if (matchesChord("Escape", event)) return true;
      const action = find(event, true);
      if (action) {
        dispatch(action.id);
        return true;
      }
    }
    const action = find(event, false);
    if (action) {
      dispatch(action.id);
      return true;
    }
    if (config.prefix && matchesChord(config.prefix, event)) {
      until = now() + config.prefixTimeoutMs;
      armed(true);
      timer = setTimeout(cancel, config.prefixTimeoutMs);
      return true;
    }
    return false;
  };
  const find = (event: KeyStroke, sequence: boolean) =>
    KEYBINDING_ACTIONS.find((action) =>
      config.bindings[action.id].some(
        (b) =>
          isPrefixBinding(b) === sequence &&
          matchesChord(bindingChord(b), event),
      ),
    );
  const usesDirect = (event: KeyStroke) =>
    !!find(event, false) ||
    !!(config.prefix && matchesChord(config.prefix, event));
  return { handle, cancel };
}
