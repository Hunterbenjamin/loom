// @vitest-environment happy-dom
import type { PaneView } from "@loom/protocol";
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { meta } from "../../../../../packages/protocol/src/test-support.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { ChimeMuteButton, PaneChime } from "./chime.js";
import { Sidebar } from "./sidebar.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

test("audio obeys window/pane focus and mute; flash is once per transition with reduced motion respected", async () => {
  const store = createStore(undefined, true);
  const publish = (value: Partial<PaneView>) =>
    store.applyProtocol(
      stateFromSnapshot(meta, {
        ...emptySnapshotBody(),
        panes: [{ ...pane, provider: "codex", ...value }],
      }),
    );
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  let reduced = false;
  vi.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        matches: reduced,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  const cancel = vi.fn();
  // Hold animations open so cleanup can be verified.
  const animate = vi.fn(() => ({ cancel, finished: new Promise(() => {}) }));
  const oldAnimate = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate as unknown as typeof oldAnimate;
  window.loomHost = {
    chooseRepository: vi.fn(),
    interactive: vi.fn(),
  } as unknown as typeof window.loomHost;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  publish({ status: "working" });
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
        children: createElement(
          Fragment,
          null,
          createElement(PaneChime),
          createElement(ChimeMuteButton),
          createElement(Sidebar, {
            filter: "",
            setFilter: vi.fn(),
            choose: vi.fn(),
            openGroup: vi.fn(),
            hidePanels: vi.fn(),
            hasPanels: () => false,
            copyAttach: vi.fn(),
            newTerminal: vi.fn(),
            openPinned: vi.fn(),
          }),
        ),
      }),
    ),
  );
  const update = (value: Partial<PaneView>) => act(async () => publish(value));
  try {
    await update({ status: "blocked" });
    expect(play).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    expect((animate.mock.contexts[0] as HTMLElement)?.dataset.paneKey).toBe(
      pane.id,
    );
    expect(
      (animate.mock.contexts[1] as HTMLElement)?.classList.contains(
        "wb-agent-row",
      ),
    ).toBe(true);
    await update({ status: "blocked", attachedClients: 5 });
    expect(play).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    const clearFocus = store.registerPaneFocus(() => pane);
    focus.mockReturnValue(true);
    await update({ status: "working" });
    await update({ status: "ended" });
    expect(play).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(4);
    focus.mockReturnValue(false);
    await update({ status: "working" });
    await update({ status: "blocked" });
    expect(play).toHaveBeenCalledTimes(2);
    clearFocus();
    focus.mockReturnValue(true);
    await update({ status: "working" });
    await update({ status: "blocked" });
    expect(play).toHaveBeenCalledTimes(3); // Focused window, different panel.
    const mute = element.querySelector<HTMLButtonElement>(
      '[aria-label="Mute transition sounds"]',
    );
    await act(async () => mute?.click());
    expect(mute?.getAttribute("aria-pressed")).toBe("true");
    expect(pause).toHaveBeenCalled();
    await update({ status: "working" });
    await update({ status: "blocked" });
    expect(play).toHaveBeenCalledTimes(3);
    expect(animate).toHaveBeenCalledTimes(10); // Mute does not remove visual feedback.
    reduced = true;
    await act(async () => mute?.click());
    play.mockRejectedValueOnce(new Error("Autoplay blocked"));
    await update({ status: "working" });
    await update({ status: "blocked" });
    expect(play).toHaveBeenCalledTimes(4);
    expect(animate).toHaveBeenCalledTimes(10);
    await act(async () => store.toast("unrelated update"));
    expect(play).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    HTMLElement.prototype.animate = oldAnimate;
  }
  expect(cancel).toHaveBeenCalled();
  publish({ status: "working" });
  publish({ status: "blocked" });
  expect(play).toHaveBeenCalledTimes(4);
});
