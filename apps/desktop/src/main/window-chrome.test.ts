import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, test, vi } from "vitest";
import { syncWindowChrome } from "./window-chrome.js";

test.each(["darwin", "win32", "linux"] as const)(
  "%s window chrome follows native fullscreen state and reloads",
  (platform) => {
    let fullscreen = false;
    const send = vi.fn();
    const webContents = Object.assign(new EventEmitter(), { send });
    const window = Object.assign(new EventEmitter(), {
      webContents,
      isFullScreen: () => fullscreen,
    });
    syncWindowChrome(window as unknown as BrowserWindow, platform);
    webContents.emit("did-finish-load");
    expect(send).toHaveBeenLastCalledWith(
      "app:window-controls-inset",
      platform === "darwin",
    );
    fullscreen = true;
    window.emit("enter-full-screen");
    expect(send).toHaveBeenLastCalledWith("app:window-controls-inset", false);
    send.mockClear();
    webContents.emit("did-finish-load");
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "app:window-controls-inset",
      false,
    );
    fullscreen = false;
    window.emit("leave-full-screen");
    expect(send).toHaveBeenLastCalledWith(
      "app:window-controls-inset",
      platform === "darwin",
    );
  },
);
