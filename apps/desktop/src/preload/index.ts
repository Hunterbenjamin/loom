import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import type {
  DevControlCommand,
  PtyExit,
  PtySpawnRequest,
} from "../shared/ipc.js";
import {
  type KeybindingsState,
  keybindingsState,
} from "../shared/keybindings.js";

const onData = new Map<string, (data: string) => void>();
const onExit = new Map<string, (info: PtyExit) => void>();
const onHistory = new Map<string, (history: string) => void>();

// The DOM exists before main publishes the initial state at did-finish-load.
window.addEventListener(
  "DOMContentLoaded",
  () => {
    ipcRenderer.on("app:window-controls-inset", (_event, raw: unknown) => {
      document.documentElement.dataset.windowControlsInset = String(
        z.boolean().parse(raw),
      );
    });
  },
  { once: true },
);

ipcRenderer.on("pty:data", (_event, id: string, data: string) =>
  onData.get(id)?.(data),
);
ipcRenderer.on("pty:history", (_event, id: string, history: string) =>
  onHistory.get(id)?.(history),
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
  onHistory: (id: string, fn: (history: string) => void) => {
    onHistory.set(id, fn);
  },
  onExit: (id: string, fn: (info: PtyExit) => void) => {
    onExit.set(id, fn);
  },
  paneFlags: (id: string) => ipcRenderer.invoke("pty:pane-flags", id),
  off: (id: string) => {
    onData.delete(id);
    onHistory.delete(id);
    onExit.delete(id);
  },
});

contextBridge.exposeInMainWorld("loomHost", {
  devControl: (command: DevControlCommand) =>
    ipcRenderer.invoke("app:dev-control", command),
  devControlAvailable: () => ipcRenderer.invoke("app:dev-control-available"),
  chooseRepository: () => ipcRenderer.invoke("app:choose-repository"),
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
  applyNativeSettings: (settings: unknown) =>
    ipcRenderer.invoke("app:apply-native-settings", settings),
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
  startDictation: () => ipcRenderer.invoke("app:start-dictation"),
  platform: process.platform,
});
