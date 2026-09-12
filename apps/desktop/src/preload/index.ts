import { contextBridge, ipcRenderer } from "electron";
import type { PtyExit, PtySpawnRequest } from "../shared/ipc.js";

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
  notify: (request: { id: string; title: string; body: string }) =>
    ipcRenderer.send("app:notify", request),
  connection: () => ipcRenderer.invoke("app:connection"),
  interactive: () => ipcRenderer.send("app:interactive"),
  metrics: () => ipcRenderer.invoke("app:metrics"),
  platform: process.platform,
});
