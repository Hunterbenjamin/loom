export const GO_TO_ACTIONS = [
  { id: "go-all", group: "Go to", label: "Issues" },
  { id: "go-needs-you", group: "Go to", label: "Inbox" },
  { id: "go-pull-requests", group: "Go to", label: "Review" },
  { id: "go-briefs", group: "Go to", label: "Daily brief" },
  { id: "go-research", group: "Go to", label: "Research" },
  { id: "go-settings", group: "Go to", label: "Settings" },
] as const;
export type GoToAction = (typeof GO_TO_ACTIONS)[number]["id"];
export function isGoToAction(action: string): action is GoToAction {
  return GO_TO_ACTIONS.some(({ id }) => id === action);
}

export const KEYBINDING_ACTIONS = [
  ...GO_TO_ACTIONS,
  { id: "split-right", group: "Panels", label: "Split right" },
  { id: "split-down", group: "Panels", label: "Split down" },
  { id: "left", group: "Panels", label: "Focus left" },
  { id: "down", group: "Panels", label: "Focus down" },
  { id: "up", group: "Panels", label: "Focus up" },
  { id: "right", group: "Panels", label: "Focus right" },
  { id: "new", group: "Tabs", label: "New tab" },
  { id: "new-space", group: "Spaces", label: "New space" },
  { id: "next", group: "Tabs", label: "Next tab" },
  { id: "previous", group: "Tabs", label: "Previous tab" },
  { id: "close", group: "Panels", label: "Close panel" },
  { id: "close-space", group: "Spaces", label: "Close space" },
  { id: "zoom", group: "Panels", label: "Zoom panel" },
  { id: "jump", group: "Agents", label: "Find agent" },
  { id: "terminal-focus", group: "Terminal", label: "Leave terminal input" },
  { id: "scroll-mode", group: "Terminal", label: "Scroll terminal history" },
  { id: "help", group: "App", label: "Keyboard map" },
  { id: "commands", group: "App", label: "Command palette" },
  {
    id: "literal",
    group: "Terminal",
    label: "Send the prefix key itself to the focused terminal",
  },
  { id: "tab-1", group: "Tabs", label: "Tab 1" },
  { id: "tab-2", group: "Tabs", label: "Tab 2" },
  { id: "tab-3", group: "Tabs", label: "Tab 3" },
  { id: "tab-4", group: "Tabs", label: "Tab 4" },
  { id: "tab-5", group: "Tabs", label: "Tab 5" },
  { id: "tab-6", group: "Tabs", label: "Tab 6" },
  { id: "tab-7", group: "Tabs", label: "Tab 7" },
  { id: "tab-8", group: "Tabs", label: "Tab 8" },
  { id: "tab-9", group: "Tabs", label: "Tab 9" },
  { id: "agent-1", group: "Agents", label: "Main" },
  { id: "agent-2", group: "Agents", label: "Agent 1" },
  { id: "agent-3", group: "Agents", label: "Agent 2" },
  { id: "agent-4", group: "Agents", label: "Agent 3" },
  { id: "agent-5", group: "Agents", label: "Agent 4" },
  { id: "agent-6", group: "Agents", label: "Agent 5" },
  { id: "agent-7", group: "Agents", label: "Agent 6" },
  { id: "agent-8", group: "Agents", label: "Agent 7" },
  { id: "agent-9", group: "Agents", label: "Agent 8" },
  { id: "space-1", group: "Spaces", label: "Space 1" },
  { id: "space-2", group: "Spaces", label: "Space 2" },
  { id: "space-3", group: "Spaces", label: "Space 3" },
  { id: "space-4", group: "Spaces", label: "Space 4" },
  { id: "space-5", group: "Spaces", label: "Space 5" },
  { id: "space-6", group: "Spaces", label: "Space 6" },
  { id: "space-7", group: "Spaces", label: "Space 7" },
  { id: "space-8", group: "Spaces", label: "Space 8" },
  { id: "space-9", group: "Spaces", label: "Space 9" },
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
  prefixTimeoutMs: number | null;
  bindings: Record<KeybindingAction, string[]>;
} = {
  prefix: "Ctrl+Space",
  prefixTimeoutMs: 3000,
  bindings: {
    "go-all": ["g i"],
    "go-needs-you": ["g n"],
    "go-pull-requests": ["g r"],
    "go-briefs": ["g d"],
    "go-research": ["g e"],
    "go-settings": ["g s"],
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
    "terminal-focus": ["Prefix q"],
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

/** Tracker sequences have two chords; Prefix bindings belong to the window matcher. */
export function bindingSequence(binding: string): [string, string] | null {
  if (isPrefixBinding(binding)) return null;
  const parts = binding.split(" ");
  return parts.length === 2 && parts.every((part) => parseChord(part))
    ? [parts[0]!, parts[1]!]
    : null;
}

export function bindingIdentity(binding: string): string {
  const sequence = bindingSequence(binding);
  return JSON.stringify(
    sequence
      ? sequence.map(parseChord)
      : [isPrefixBinding(binding), parseChord(bindingChord(binding))],
  );
}

export function validateKeybindings(config: {
  prefix: string | null;
  bindings: Record<string, string[]>;
}): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  const normalized = (chord: string) => JSON.stringify(parseChord(chord));
  const reserved = ["Cmd+Shift+W", "Cmd+J"].map(normalized);
  const prefix = normalized(config.prefix ?? "");
  const escapeChord = normalized("Escape");
  const seen = new Set<string>();
  const direct = new Set(
    Object.values(config.bindings)
      .flat()
      .filter((b) => !isPrefixBinding(b) && !bindingSequence(b))
      .map(normalized),
  );
  for (const [action, bindings] of Object.entries(config.bindings)) {
    for (const value of bindings) {
      const sequence = bindingSequence(value);
      const prefixed = isPrefixBinding(value);
      const chord = parseChord(bindingChord(value));
      const identity = bindingIdentity(value);
      const problem = (() => {
        if (!sequence && !chord) return "Invalid binding";
        if (sequence && !isGoToAction(action))
          return "Two-key sequences are only available for Go to actions";
        if (prefixed && !config.prefix) return "Prefix binding needs a prefix";
        if (seen.has(identity)) return "Duplicate binding";
        if (sequence && sequence.some((c) => normalized(c) === escapeChord))
          return "Escape cancels a sequence";
        if (prefixed && normalized(bindingChord(value)) === escapeChord)
          return "Escape cancels the prefix";
        const chords = sequence ?? [bindingChord(value)];
        if (
          chords.some(
            (c) =>
              reserved.includes(normalized(c)) ||
              (!prefixed && normalized(c) === prefix),
          )
        )
          return "Chord conflicts with the prefix or a reserved app shortcut";
        // Window shortcuts capture both strokes before Tracker's listener.
        if (sequence && sequence.some((c) => direct.has(normalized(c))))
          return "Sequence chord conflicts with a direct binding";
        if (
          isGoToAction(action) &&
          !prefixed &&
          !sequence &&
          chord &&
          !chord.ctrlKey &&
          !chord.metaKey &&
          !chord.altKey
        )
          return "Go to actions need a two-key sequence, a prefix binding or a modified chord";
        return null;
      })();
      if (problem)
        issues.push({ path: ["bindings", action], message: problem });
      seen.add(identity);
    }
  }
  if (config.prefix && reserved.includes(prefix))
    issues.push({ path: ["prefix"], message: "Reserved app shortcut" });
  return issues;
}
