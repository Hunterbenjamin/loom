// @vitest-environment happy-dom
import { Command } from "cmdk";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DevControlCommands } from "./dev-controls.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, true, "error"])(
  "palette dev entries follow host availability %s",
  async (available) => {
    const devControl = vi.fn().mockResolvedValue(undefined);
    window.loomHost = {
      devControlAvailable:
        available === "error"
          ? vi.fn().mockRejectedValue(new Error("IPC unavailable"))
          : vi.fn().mockResolvedValue(available),
      devControl,
    } as unknown as typeof window.loomHost;
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const close = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(
            Command,
            { label: "Workbench commands" },
            createElement(
              Command.List,
              null,
              createElement(DevControlCommands, { close }),
            ),
          ),
        ),
      );
      const entries = [...element.querySelectorAll<HTMLElement>("[cmdk-item]")];
      expect(entries.map((entry) => entry.textContent)).toEqual(
        available === true
          ? [
              "Instance: sync",
              "Instance: restart coordinator",
              "Instance: restart app",
            ]
          : [],
      );
      if (available === true) {
        for (const [index, command] of [
          "sync",
          "restart-coordinator",
          "restart-app",
        ].entries()) {
          await act(async () => entries[index]?.click());
          expect(devControl).toHaveBeenLastCalledWith(command);
        }
        expect(close).toHaveBeenCalledTimes(3);
        vi.stubGlobal("alert", vi.fn());
        devControl.mockRejectedValueOnce(new Error("tmux unavailable"));
        await act(async () => entries[0]?.click());
        expect(window.alert).toHaveBeenCalledWith("Error: tmux unavailable");
      } else expect(devControl).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  },
);
