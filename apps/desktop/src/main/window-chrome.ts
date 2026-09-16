import type { BrowserWindow } from "electron";

/** Electron owns whether the hidden-inset controls occupy renderer space. */
export function syncWindowChrome(
  window: BrowserWindow,
  platform = process.platform,
): void {
  const publish = () =>
    window.webContents.send(
      "app:window-controls-inset",
      platform === "darwin" && !window.isFullScreen(),
    );
  // Republish after every load, including a reload while already in fullscreen.
  window.webContents.on("did-finish-load", publish);
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
}
