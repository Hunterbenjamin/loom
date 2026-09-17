import type { KeybindingAction } from "@loom/core";
import { createContext, useContext } from "react";
import { defaultKeybindings } from "../shared/keybindings.js";
import type { useKeybindings } from "./workbench/use-keybindings.js";

/** The window's effective bindings and help state. Kept apart from the listener, which pulls in
 * the terminal, so a hint can read the bindings without loading xterm. */
export type Dispatch = (action: KeybindingAction) => void;
export const WindowKeybindingsContext = createContext<
  | (ReturnType<typeof useKeybindings> & {
      help: boolean;
      dispatch: Dispatch;
      showHelp(): void;
      closeHelp(): void;
      workbench: { current: Dispatch | null };
    })
  | null
>(null);

/** The effective bindings for display; the defaults where no window provider is mounted. */
export function useKeybindingsConfig() {
  return (
    useContext(WindowKeybindingsContext)?.bindings.config ?? defaultKeybindings
  );
}
