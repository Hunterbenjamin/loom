export const KEYBINDING_ACTIONS = [
  { id: "split-right", label: "Split right" },
  { id: "split-down", label: "Split down" },
  { id: "left", label: "Focus left" },
  { id: "down", label: "Focus down" },
  { id: "up", label: "Focus up" },
  { id: "right", label: "Focus right" },
  { id: "new", label: "New tab" },
  { id: "new-space", label: "New space" },
  { id: "next", label: "Next tab" },
  { id: "previous", label: "Previous tab" },
  { id: "close", label: "Close panel" },
  { id: "close-space", label: "Close space" },
  { id: "zoom", label: "Zoom panel" },
  { id: "jump", label: "Find agent" },
  { id: "scroll-mode", label: "Scroll terminal history" },
  { id: "help", label: "Shortcut map" },
  { id: "commands", label: "Command palette" },
  {
    id: "literal",
    label: "Send the prefix key itself to the focused terminal",
  },
  { id: "tab-1", label: "Tab 1" },
  { id: "tab-2", label: "Tab 2" },
  { id: "tab-3", label: "Tab 3" },
  { id: "tab-4", label: "Tab 4" },
  { id: "tab-5", label: "Tab 5" },
  { id: "tab-6", label: "Tab 6" },
  { id: "tab-7", label: "Tab 7" },
  { id: "tab-8", label: "Tab 8" },
  { id: "tab-9", label: "Tab 9" },
  { id: "agent-1", label: "Main" },
  { id: "agent-2", label: "Agent 1" },
  { id: "agent-3", label: "Agent 2" },
  { id: "agent-4", label: "Agent 3" },
  { id: "agent-5", label: "Agent 4" },
  { id: "agent-6", label: "Agent 5" },
  { id: "agent-7", label: "Agent 6" },
  { id: "agent-8", label: "Agent 7" },
  { id: "agent-9", label: "Agent 8" },
  { id: "space-1", label: "Space 1" },
  { id: "space-2", label: "Space 2" },
  { id: "space-3", label: "Space 3" },
  { id: "space-4", label: "Space 4" },
  { id: "space-5", label: "Space 5" },
  { id: "space-6", label: "Space 6" },
  { id: "space-7", label: "Space 7" },
  { id: "space-8", label: "Space 8" },
  { id: "space-9", label: "Space 9" },
] as const;

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number]["id"];

export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const modifiers = new Set(["Ctrl", "Cmd", "Alt", "Shift"]);
const namedKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Plus",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

// Shifted punctuation can arrive as either the symbol or the base key, depending
// on the keyboard layout / Electron input path. Match both without ignoring Shift.
const shifted: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

export function parseChord(value: string): KeyStroke | null {
  const parts = value.split("+");
  const last = parts.pop();
  if (
    !last ||
    parts.some((part) => !modifiers.has(part)) ||
    new Set(parts).size !== parts.length
  )
    return null;
  if (!/^[\x21-\x7e]$/.test(last) && !namedKeys.has(last)) return null;
  const key =
    last === "Space" ? " " : last === "Plus" ? "+" : last.toLowerCase();
  return {
    key: shifted[key] ?? key,
    ctrlKey: parts.includes("Ctrl"),
    metaKey: parts.includes("Cmd"),
    altKey: parts.includes("Alt"),
    shiftKey: parts.includes("Shift") || key in shifted,
  };
}

export function matchesChord(chord: string, event: KeyStroke): boolean {
  const expected = parseChord(chord);
  const key = event.key.toLowerCase();
  return (
    !!expected &&
    expected.key === (event.shiftKey ? (shifted[key] ?? key) : key) &&
    expected.ctrlKey === event.ctrlKey &&
    expected.metaKey === event.metaKey &&
    expected.altKey === event.altKey &&
    expected.shiftKey === event.shiftKey
  );
}

export const isPrefixBinding = (binding: string) =>
  binding.startsWith("Prefix ");
export const bindingChord = (binding: string) =>
  isPrefixBinding(binding) ? binding.slice(7) : binding;

export const DEFAULT_KEYBINDINGS: {
  prefix: string | null;
  prefixTimeoutMs: number;
  bindings: Record<KeybindingAction, string[]>;
} = {
  prefix: "Ctrl+Space",
  prefixTimeoutMs: 3000,
  bindings: {
    "split-right": ["Cmd+D", "Prefix |"],
    "split-down": ["Cmd+Shift+D", "Prefix -"],
    left: ["Cmd+Alt+ArrowLeft", "Prefix h"],
    down: ["Cmd+Alt+ArrowDown", "Prefix j"],
    up: ["Cmd+Alt+ArrowUp", "Prefix k"],
    right: ["Cmd+Alt+ArrowRight", "Prefix l"],
    new: ["Cmd+T", "Prefix c"],
    "new-space": ["Cmd+N", "Prefix Shift+C"],
    next: ["Cmd+Shift+]", "Prefix n"],
    previous: ["Cmd+Shift+[", "Prefix p"],
    close: ["Cmd+W", "Prefix x"],
    "close-space": ["Cmd+Alt+W", "Prefix Shift+X"],
    zoom: ["Cmd+Shift+Enter", "Prefix z"],
    jump: ["Cmd+P", "Prefix g"],
    "scroll-mode": ["Prefix ["],
    help: ["Prefix ?"],
    commands: ["Cmd+K"],
    literal: ["Prefix Ctrl+Space"],
    "tab-1": ["Cmd+1"],
    "tab-2": ["Cmd+2"],
    "tab-3": ["Cmd+3"],
    "tab-4": ["Cmd+4"],
    "tab-5": ["Cmd+5"],
    "tab-6": ["Cmd+6"],
    "tab-7": ["Cmd+7"],
    "tab-8": ["Cmd+8"],
    "tab-9": ["Cmd+9"],
    "agent-1": ["Ctrl+1"],
    "agent-2": ["Ctrl+2"],
    "agent-3": ["Ctrl+3"],
    "agent-4": ["Ctrl+4"],
    "agent-5": ["Ctrl+5"],
    "agent-6": ["Ctrl+6"],
    "agent-7": ["Ctrl+7"],
    "agent-8": ["Ctrl+8"],
    "agent-9": ["Ctrl+9"],
    "space-1": ["Prefix 1"],
    "space-2": ["Prefix 2"],
    "space-3": ["Prefix 3"],
    "space-4": ["Prefix 4"],
    "space-5": ["Prefix 5"],
    "space-6": ["Prefix 6"],
    "space-7": ["Prefix 7"],
    "space-8": ["Prefix 8"],
    "space-9": ["Prefix 9"],
  },
};
