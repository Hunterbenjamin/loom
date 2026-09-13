import { useSyncExternalStore } from "react";
import type { Indicator } from "./selectors.js";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const listeners = new Set<() => void>();
let frame = 0;
let reduced = false;
let timer: ReturnType<typeof setInterval> | undefined;
let dispose: (() => void) | undefined;
const emit = () => {
  for (const listener of listeners) listener();
};
const snapshot = () => (reduced ? "◌" : frames[frame]);

// One clock per renderer, regardless of how many tree/agent rollups are visible.
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reduced = motion.matches;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (!document.hidden && !reduced) {
        timer = setInterval(() => {
          frame = (frame + 1) % frames.length;
          emit();
        }, 80);
      }
      emit();
    };
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    dispose = () => {
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      frame = 0;
    };
    sync();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      dispose?.();
      dispose = undefined;
    }
  };
}

function Spinner() {
  return useSyncExternalStore(subscribe, snapshot, () => "◌");
}

export function Status({ state }: { state: Indicator }) {
  return (
    <span
      className={`wb-status ${state.tone}`}
      role="img"
      aria-label={state.label}
    >
      {state.tone === "working" ? (
        <Spinner />
      ) : state.tone === "waiting" ? (
        "●"
      ) : (
        state.icon
      )}
    </span>
  );
}
