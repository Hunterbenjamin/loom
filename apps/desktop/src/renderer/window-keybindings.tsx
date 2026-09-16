import type { KeybindingAction } from "@loom/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { enterFocusedScrollMode } from "./ui/terminal.js";
import {
  useKeybindingListener,
  useKeybindings,
} from "./workbench/use-keybindings.js";

type Dispatch = (action: KeybindingAction) => void;
const WindowKeybindingsContext = createContext<
  | (ReturnType<typeof useKeybindings> & {
      help: boolean;
      showHelp(): void;
      closeHelp(): void;
      workbench: { current: Dispatch | null };
    })
  | null
>(null);

export function WindowKeybindings({ children }: { children: ReactNode }) {
  const state = useKeybindings();
  const [help, setHelp] = useState(false);
  const showHelp = useCallback(() => setHelp(true), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  const workbench = useRef<Dispatch | null>(null);
  useKeybindingListener({
    ...state,
    dispatch(action) {
      if (action === "scroll-mode") enterFocusedScrollMode();
      else if (action === "help") showHelp();
      else workbench.current?.(action);
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
