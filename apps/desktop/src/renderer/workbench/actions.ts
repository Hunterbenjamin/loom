export const actions = [
  { id: "split-right", key: "|", label: "Split right" },
  { id: "split-down", key: "-", label: "Split down" },
  { id: "left", key: "h", label: "Focus left" },
  { id: "down", key: "j", label: "Focus down" },
  { id: "up", key: "k", label: "Focus up" },
  { id: "right", key: "l", label: "Focus right" },
  { id: "new", key: "c", label: "New tab" },
  { id: "next", key: "n", label: "Next tab" },
  { id: "previous", key: "p", label: "Previous tab" },
  { id: "close", key: "x", label: "Close panel" },
  { id: "zoom", key: "z", label: "Zoom panel" },
  { id: "jump", key: "g", label: "Find agent" },
  { id: "help", key: "?", label: "Shortcut map" },
] as const;
export type Action = (typeof actions)[number]["id"];
/** Ctrl+A Ctrl+A sends a literal prefix. Unknown commands cancel and pass through normally. */
export function prefixKeys(
  dispatch: (action: Action) => void,
  literal: () => void,
  now = Date.now,
) {
  let until = 0;
  return (
    event: Pick<
      KeyboardEvent,
      "key" | "ctrlKey" | "metaKey" | "altKey" | "type"
    >,
  ): boolean => {
    if (event.type !== "keydown") return false;
    const prefix =
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === "a";
    if (until && now() <= until) {
      until = 0;
      if (prefix) {
        literal();
        return true;
      }
      if (event.key === "Escape") return true;
      const action = actions.find((a) => a.key === event.key);
      if (action) {
        dispatch(action.id);
        return true;
      }
      return false;
    }
    until = 0;
    if (prefix) {
      until = now() + 1500;
      return true;
    }
    return false;
  };
}
