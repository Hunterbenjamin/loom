import {
  bindingChord,
  DEFAULT_KEYBINDINGS,
  isPrefixBinding,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
  type KeyStroke,
  matchesChord,
  parseChord,
} from "@loom/core";
import { z } from "zod";

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
      z.enum(KEYBINDING_ACTIONS.map((action) => action.id)),
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
  ...DEFAULT_KEYBINDINGS,
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
  action: KeybindingAction,
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
