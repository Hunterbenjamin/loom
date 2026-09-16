import { eventKey } from "./event-key.js";

/** The reading vocabulary, in eventKey syntax. q is terminal-only. */
export const scrollBindings = [
  { id: "scroll-down", keys: ["j"], label: "Scroll down" },
  { id: "scroll-up", keys: ["k"], label: "Scroll up" },
  { id: "half-page-down", keys: ["Control+d"], label: "Half page down" },
  { id: "half-page-up", keys: ["Control+u"], label: "Half page up" },
  {
    id: "page-down",
    keys: ["Space", "Shift+PageDown", "Meta+ArrowDown"],
    label: "Page down",
  },
  {
    id: "page-up",
    keys: ["Shift+Space", "Shift+PageUp", "Meta+ArrowUp"],
    label: "Page up",
  },
  { id: "top", keys: ["g g"], label: "Scroll to top" },
  { id: "bottom", keys: ["G"], label: "Scroll to bottom" },
  {
    id: "leave",
    keys: ["Escape", "q"],
    label: "Leave reading mode (q: terminal only)",
  },
] as const;

export type ScrollCommand = (typeof scrollBindings)[number]["id"];
type KeyEvent = Parameters<typeof eventKey>[0];

export function typingScrollCommand(event: KeyEvent): ScrollCommand | null {
  const key = eventKey(event);
  return (
    scrollBindings.find((entry) =>
      entry.keys.some(
        (binding) =>
          (binding.startsWith("Shift+Page") ||
            binding.startsWith("Meta+Arrow")) &&
          binding === key,
      ),
    )?.id ?? null
  );
}

export function createScrollMatcher(terminal = false) {
  let pending = false;
  return {
    reset() {
      pending = false;
    },
    match(event: KeyEvent): ScrollCommand | "pending" | null {
      const key = eventKey(event);
      const top = scrollBindings.find((entry) => entry.id === "top")!.keys[0];
      const prefix = top.split(" ")[0];
      const sequence = pending ? `${prefix} ${key}` : key;
      pending = false;
      if (sequence === top) return "top";
      if (key === prefix) {
        pending = true;
        return "pending";
      }
      return (
        scrollBindings.find((entry) =>
          entry.keys.some(
            (binding) =>
              binding === key &&
              (terminal || entry.id !== "leave" || binding === entry.keys[0]),
          ),
        )?.id ?? null
      );
    },
  };
}

export function scrollDistance(
  command: ScrollCommand,
  page: number,
  line = 1,
): number {
  switch (command) {
    case "scroll-down":
      return line;
    case "scroll-up":
      return -line;
    case "half-page-down":
      return Math.max(line, Math.floor(page / 2));
    case "half-page-up":
      return -Math.max(line, Math.floor(page / 2));
    case "page-down":
      return page;
    case "page-up":
      return -page;
    default:
      return 0;
  }
}
