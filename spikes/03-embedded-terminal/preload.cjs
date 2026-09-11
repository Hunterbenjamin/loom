const { contextBridge, ipcRenderer } = require('electron');

const dataHandlers = new Map();
const exitHandlers = new Map();
ipcRenderer.on('pty:data', (_e, id, data) => dataHandlers.get(id)?.(data));
ipcRenderer.on('pty:exit', (_e, id, info) => exitHandlers.get(id)?.(info));

contextBridge.exposeInMainWorld('pty', {
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id, signal) => ipcRenderer.invoke('pty:kill', id, signal),
  list: () => ipcRenderer.invoke('pty:list'),
  onData: (id, fn) => {
    dataHandlers.set(id, fn);
  },
  onExit: (id, fn) => {
    exitHandlers.set(id, fn);
  },
  off: (id) => {
    dataHandlers.delete(id);
    exitHandlers.delete(id);
  },
});
contextBridge.exposeInMainWorld('host', {
  clipboardWrite: (t) => ipcRenderer.invoke('clipboard:write', t),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  metrics: () => ipcRenderer.invoke('app:metrics'),
});
