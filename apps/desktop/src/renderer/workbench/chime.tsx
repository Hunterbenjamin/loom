import type { PaneView } from "@loom/protocol";
import { Command } from "cmdk";
import { useEffect } from "react";
import chimeUrl from "../assets/transition-chime.wav?url";
import { paneKey } from "../store/pane-transitions.js";
import { useStore, useStoreApi } from "../store/react.js";
import type { Store } from "../store/store.js";

function focused(store: Store, pane: PaneView) {
  if (!document.hasFocus()) return false;
  const target = document.activeElement?.closest(".lead-panel")
    ? "main"
    : store.focusedPane();
  if (target === "main")
    return pane.sessionName === "loom-lead" || pane.sessionName === "loom-main";
  if (target === "operator") return pane.sessionName === "loom-operator";
  return target !== undefined && paneKey(target) === paneKey(pane);
}

/** One listener per window, outside either mode's suspended subtree. */
export function PaneChime() {
  const store = useStoreApi();
  useEffect(() => {
    const playing = new Set<HTMLAudioElement>();
    const stop = store.subscribePaneTransitions((pane) => {
      if (store.getState().ui.chimeMuted || focused(store, pane)) return;
      // Ordinary media output obeys OS/app mute; never use a system beep or change volume.
      const audio = new Audio(chimeUrl);
      playing.add(audio);
      const release = () => playing.delete(audio);
      audio.addEventListener("ended", release, { once: true });
      audio.addEventListener("error", release, { once: true });
      void audio.play().catch(release); // Do not replay alerts blocked by autoplay policy.
    });
    const unsubscribeMute = store.subscribe(() => {
      if (store.getState().ui.chimeMuted) {
        for (const audio of playing) audio.pause();
        playing.clear();
      }
    });
    return () => {
      stop();
      unsubscribeMute();
      for (const audio of playing) audio.pause();
    };
  }, [store]);
  return null;
}

export function ChimeMuteButton() {
  const store = useStoreApi();
  const muted = useStore((s) => s.ui.chimeMuted);
  return (
    <button
      type="button"
      aria-label="Mute transition sounds"
      aria-pressed={muted}
      onClick={() => store.toggleChimeMuted()}
    >
      Sound {muted ? "off" : "on"}
    </button>
  );
}

export function ChimeMuteCommand({ close }: { close: () => void }) {
  const store = useStoreApi();
  const muted = useStore((s) => s.ui.chimeMuted);
  return (
    <Command.Item
      onSelect={() => {
        store.toggleChimeMuted();
        close();
      }}
    >
      {muted ? "Unmute" : "Mute"} transition sounds
    </Command.Item>
  );
}
