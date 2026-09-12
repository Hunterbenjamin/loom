/**
 * Herdr asks the client for kitty keyboard flags (CSI > 5 u) and passes CSI-u straight through
 * to the agent, but xterm.js 6.0 ignores the request. Without this, Shift+Enter arrives as a
 * bare CR and both Claude and Codex submit the prompt instead of inserting a newline.
 */
const KITTY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 127,
};

export function kittyEncode(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}): string | null {
  const code = KITTY_CODES[event.key];
  if (code === undefined) return null;
  const modifiers =
    1 +
    (event.shiftKey ? 1 : 0) +
    (event.altKey ? 2 : 0) +
    (event.ctrlKey ? 4 : 0);
  if (modifiers === 1) return null;
  return `\u001b[${code};${modifiers}u`;
}
