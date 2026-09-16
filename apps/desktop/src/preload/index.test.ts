// @vitest-environment happy-dom
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: new EventEmitter(),
}));

test("native window chrome updates the document and rejects invalid IPC", async () => {
  const { ipcRenderer } = await import("electron");
  await import("./index.js");
  window.dispatchEvent(new Event("DOMContentLoaded"));
  try {
    for (const inset of [true, false, true]) {
      ipcRenderer.emit("app:window-controls-inset", {}, inset);
      expect(document.documentElement.dataset.windowControlsInset).toBe(
        String(inset),
      );
    }
    expect(() =>
      ipcRenderer.emit("app:window-controls-inset", {}, "false"),
    ).toThrow();
    expect(document.documentElement.dataset.windowControlsInset).toBe("true");
  } finally {
    ipcRenderer.removeAllListeners();
    delete document.documentElement.dataset.windowControlsInset;
  }
});
