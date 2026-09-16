export function eventKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): string {
  const key = event.key === " " ? "Space" : event.key;
  return `${event.metaKey ? "Meta+" : ""}${event.ctrlKey ? "Control+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey && (key.length > 1 || event.metaKey || event.ctrlKey || event.altKey) ? "Shift+" : ""}${key}`;
}
