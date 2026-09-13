import { contextBridge, ipcRenderer } from "electron";
import type { PtyExit, PtySpawnRequest } from "../shared/ipc.js";
import {
  type KeybindingsState,
  keybindingsState,
} from "../shared/keybindings.js";

const onData = new Map<string, (data: string) => void>();
const onExit = new Map<string, (info: PtyExit) => void>();

ipcRenderer.on("pty:data", (_event, id: string, data: string) =>
  onData.get(id)?.(data),
);
ipcRenderer.on("pty:exit", (_event, id: string, info: PtyExit) =>
  onExit.get(id)?.(info),
);

contextBridge.exposeInMainWorld("loomTerminal", {
  spawn: (request: PtySpawnRequest) => ipcRenderer.invoke("pty:spawn", request),
  write: (id: string, data: string) => ipcRenderer.send("pty:write", id, data),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("pty:resize", id, cols, rows),
  kill: (id: string) => ipcRenderer.invoke("pty:kill", id),
  // Block bodies on purpose: `Map.set` returns the map, and contextBridge cannot clone a
  // Map holding a proxied function back into the renderer ("An object could not be cloned").
  onData: (id: string, fn: (data: string) => void) => {
    onData.set(id, fn);
  },
  onExit: (id: string, fn: (info: PtyExit) => void) => {
    onExit.set(id, fn);
  },
  off: (id: string) => {
    onData.delete(id);
    onExit.delete(id);
  },
});

contextBridge.exposeInMainWorld("loomHost", {
  // IPC callbacks can run under the renderer CSP; validation must not use eval.
  keybindings: async () =>
    keybindingsState.parse(await ipcRenderer.invoke("app:keybindings"), {
      jitless: true,
    }),
  onKeybindingsChanged: (listener: (state: KeybindingsState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) =>
      listener(keybindingsState.parse(raw, { jitless: true }));
    ipcRenderer.on("app:keybindings-changed", handler);
    return () => ipcRenderer.removeListener("app:keybindings-changed", handler);
  },
  notify: (request: { id: string; title: string; body: string }) =>
    ipcRenderer.send("app:notify", request),
  mode: () => ipcRenderer.invoke("app:mode"),
  setMode: (mode: string) => ipcRenderer.invoke("app:set-mode", mode),
  onModeChanged: (listener: (mode: "tracker" | "workbench") => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      mode: "tracker" | "workbench",
    ) => listener(mode);
    ipcRenderer.on("app:mode-changed", handler);
    return () => ipcRenderer.removeListener("app:mode-changed", handler);
  },
  openWindow: (mode: string) => ipcRenderer.invoke("app:open-window", mode),
  connection: () => ipcRenderer.invoke("app:connection"),
  interactive: () => ipcRenderer.send("app:interactive"),
  metrics: () => ipcRenderer.invoke("app:metrics"),
  platform: process.platform,
});
