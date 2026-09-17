import {
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { WindowMode } from "../shared/ipc.js";
import {
  type Dispatch,
  WindowKeybindingsContext,
} from "./keybindings-context.js";
import { useStoreApi } from "./store/react.js";
import { togglePalette } from "./ui/keys.js";
import { enterFocusedScrollMode } from "./ui/terminal.js";
import {
  useKeybindingListener,
  useKeybindings,
} from "./workbench/use-keybindings.js";

/**
 * One listener for the editable bindings in both windows. The Tracker and the Workbench stay
 * mounted together (hidden when not shown), so an action goes to the mode on screen: the palette
 * chord opens the visible window's palette, and Workbench-only actions fire only in the Workbench.
 */
export function WindowKeybindings({
  mode,
  children,
}: {
  mode: WindowMode;
  children?: ReactNode;
}) {
  const store = useStoreApi();
  const state = useKeybindings();
  const [help, setHelp] = useState(false);
  const showHelp = useCallback(() => setHelp(true), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  const workbench = useRef<Dispatch | null>(null);
  useKeybindingListener({
    ...state,
    dispatch(action) {
      if (action === "terminal-focus") {
        const active = document.activeElement;
        if (
          !(active instanceof HTMLElement) ||
          !active.closest(".terminal-host, .xterm")
        )
          return;
        const header = active
          .closest(".detail")
          ?.querySelector<HTMLElement>(".pr-page-head");
        if (header) header.focus();
        else active.blur();
        if (mode === "workbench") void window.loomHost.setMode("tracker");
      } else if (action === "scroll-mode") enterFocusedScrollMode();
      else if (action === "help") showHelp();
      else if (mode === "workbench") workbench.current?.(action);
      else if (action === "commands") togglePalette(store);
    },
  });
  return (
    <WindowKeybindingsContext
      value={{ ...state, workbench, help, showHelp, closeHelp }}
    >
      {children}
    </WindowKeybindingsContext>
  );
}

export function useWorkbenchKeybindings(dispatch: Dispatch) {
  const context = useContext(WindowKeybindingsContext);
  if (!context) throw new Error("Missing window keybindings");
  const { workbench } = context;
  useLayoutEffect(() => {
    workbench.current = dispatch;
    return () => {
      workbench.current = null;
    };
  }, [workbench, dispatch]);
  return context;
}

export function useWindowKeybindings() {
  const context = useContext(WindowKeybindingsContext);
  if (!context) throw new Error("Missing window keybindings");
  return context;
}
