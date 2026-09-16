import {
  isPrefixBinding,
  type KeybindingAction,
  matchesChord,
} from "@loom/core";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  defaultKeybindingsState,
  type KeybindingsState,
} from "../../shared/keybindings.js";
import { bindingMatcher } from "./actions.js";

export const useKeybindings = () => {
  const [bindings, setBindings] = useState<KeybindingsState>(
    defaultKeybindingsState,
  );
  const [prefixArmed, setPrefixArmed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let pushed = false;
    const unsubscribe = window.loomHost.onKeybindingsChanged((state) => {
      pushed = true;
      if (!disposed) setBindings(state);
    });
    void window.loomHost
      .keybindings()
      .then((state) => {
        if (!disposed && !pushed) setBindings(state);
      })
      .catch(() => {
        if (!disposed && !pushed)
          setBindings({
            ...defaultKeybindingsState,
            error: "Cannot load keybindings; using defaults",
          });
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return { bindings, prefixArmed, setPrefixArmed };
};

/** One capture listener at the window root, ahead of xterm. */
export const useKeybindingListener = ({
  bindings,
  dispatch,
  setPrefixArmed,
}: {
  bindings: KeybindingsState;
  dispatch: (action: KeybindingAction) => void;
  setPrefixArmed: Dispatch<SetStateAction<boolean>>;
}) => {
  const latest = useRef(dispatch);
  latest.current = dispatch;
  useEffect(() => {
    const matcher = bindingMatcher(
      bindings.config,
      (action) => latest.current(action),
      setPrefixArmed,
    );
    const key = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) {
        matcher.cancel();
        return;
      }
      // Outside native dialogs, the palette chord opens and closes the palette.
      if (
        event.type === "keydown" &&
        !event.repeat &&
        (bindings.config.bindings.commands ?? [])
          .filter((binding) => !isPrefixBinding(binding))
          .some((binding) => matchesChord(binding, event))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        matcher.cancel();
        latest.current("commands");
        return;
      }
      if (
        document.querySelector('[aria-modal="true"], [role="menu"]') ||
        (event.target instanceof Element && event.target.closest(".wb-rename"))
      ) {
        matcher.cancel();
        return;
      }
      if (matcher.handle(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", matcher.cancel);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", matcher.cancel);
      matcher.cancel();
    };
  }, [bindings.config, setPrefixArmed]);
};
