import { createContext, useContext } from "react";
import type { WindowMode } from "../shared/ipc.js";

export const WindowModeContext = createContext<WindowMode>("tracker");
export const useWindowMode = () => useContext(WindowModeContext);
