import { z } from "zod";

export const actions = [
  { id: "split-right", label: "Split right" },
  { id: "split-down", label: "Split down" },
  { id: "left", label: "Focus left" },
  { id: "down", label: "Focus down" },
  { id: "up", label: "Focus up" },
  { id: "right", label: "Focus right" },
  { id: "new", label: "New tab" },
  { id: "next", label: "Next tab" },
  { id: "previous", label: "Previous tab" },
  { id: "close", label: "Close panel" },
  { id: "close-space", label: "Close space" },
  { id: "zoom", label: "Zoom panel" },
  { id: "jump", label: "Find agent" },
  { id: "help", label: "Shortcut map" },
  { id: "commands", label: "Command palette" },
  { id: "literal", label: "Send literal Ctrl+A to focused terminal" },
] as const;
export type Action = (typeof actions)[number]["id"];

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
    parts.some((p) => !modifiers.has(p)) ||
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
const chord = z
  .string()
  .max(80)
  .refine((value) => parseChord(value) !== null, "Invalid chord");
const binding = z
  .string()
  .max(90)
  .refine(
    (value) => parseChord(bindingChord(value)) !== null,
    "Invalid binding",
  );
export const keybindingsConfig = z
  .strictObject({
    version: z.literal(1),
    prefix: chord.nullable(),
    prefixTimeoutMs: z.number().int().min(100).max(60000),
    bindings: z.record(
      z.enum(actions.map((a) => a.id)),
      z.array(binding).max(20),
    ),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    const reserved = ["Cmd+Shift+W", "Cmd+J"].map((c) =>
      JSON.stringify(parseChord(c)),
    );
    for (const [action, bindings] of Object.entries(config.bindings)) {
      for (const value of bindings) {
        const sequence = isPrefixBinding(value);
        const normalized = JSON.stringify(parseChord(bindingChord(value)));
        const identity = `${sequence}:${normalized}`;
        const problem =
          sequence && !config.prefix
            ? "Prefix binding needs a prefix"
            : seen.has(identity)
              ? "Duplicate binding"
              : reserved.includes(normalized) ||
                  (!sequence &&
                    normalized ===
                      JSON.stringify(parseChord(config.prefix ?? "")))
                ? "Chord conflicts with the prefix or a reserved app shortcut"
                : null;
        if (problem)
          ctx.addIssue({
            code: "custom",
            path: ["bindings", action],
            message: problem,
          });
        if (sequence && normalized === JSON.stringify(parseChord("Escape")))
          ctx.addIssue({
            code: "custom",
            path: ["bindings", action],
            message: "Escape cancels the prefix",
          });
        seen.add(identity);
      }
    }
    if (
      config.prefix &&
      reserved.includes(JSON.stringify(parseChord(config.prefix)))
    )
      ctx.addIssue({
        code: "custom",
        path: ["prefix"],
        message: "Reserved app shortcut",
      });
  });
export type KeybindingsConfig = z.output<typeof keybindingsConfig>;
export const defaultKeybindings: KeybindingsConfig = keybindingsConfig.parse({
  version: 1,
  prefix: "Ctrl+A",
  prefixTimeoutMs: 3000,
  bindings: {
    "split-right": ["Cmd+D", "Prefix |"],
    "split-down": ["Cmd+Shift+D", "Prefix -"],
    left: ["Cmd+Alt+ArrowLeft", "Prefix h"],
    down: ["Cmd+Alt+ArrowDown", "Prefix j"],
    up: ["Cmd+Alt+ArrowUp", "Prefix k"],
    right: ["Cmd+Alt+ArrowRight", "Prefix l"],
    new: ["Cmd+T", "Prefix c"],
    next: ["Cmd+Shift+]", "Prefix n"],
    previous: ["Cmd+Shift+[", "Prefix p"],
    close: ["Cmd+W", "Prefix x"],
    "close-space": ["Cmd+Alt+W", "Prefix Shift+X"],
    zoom: ["Cmd+Shift+Enter", "Prefix z"],
    jump: ["Cmd+P", "Prefix g"],
    help: ["Prefix ?"],
    commands: ["Cmd+K"],
    literal: ["Prefix Ctrl+A"],
  },
});
export const keybindingsState = z.strictObject({
  config: keybindingsConfig,
  path: z.string().nullable(),
  error: z.string().nullable(),
});
export type KeybindingsState = z.output<typeof keybindingsState>;
export const defaultKeybindingsState: KeybindingsState = {
  config: defaultKeybindings,
  path: null,
  error: null,
};
export function formatBindings(
  config: KeybindingsConfig,
  action: Action,
): string {
  return (
    config.bindings[action]
      .map((b) =>
        isPrefixBinding(b) ? `${config.prefix} then ${bindingChord(b)}` : b,
      )
      .join(" / ") || "Unbound"
  );
}
/** Only suppress native menu accelerators for configured Workbench keys. Never
 * preventDefault in before-input-event: that would also hide them from the DOM. */
export function usesWorkbenchKey(
  config: KeybindingsConfig,
  event: KeyStroke,
): boolean {
  return (
    !!(config.prefix && matchesChord(config.prefix, event)) ||
    Object.values(config.bindings).some((bindings) =>
      bindings.some((b) => matchesChord(bindingChord(b), event)),
    )
  );
}
