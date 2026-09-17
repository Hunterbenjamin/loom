import {
  bindingChord,
  bindingSequence,
  DEFAULT_KEYBINDINGS,
  GO_TO_ACTIONS,
  isPrefixBinding,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
  type KeyStroke,
  matchesChord,
  parseChord,
  validateKeybindings,
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
    (value) =>
      bindingSequence(value) !== null ||
      parseChord(bindingChord(value)) !== null,
    "Invalid binding",
  );
export const keybindingsConfig = z
  .strictObject({
    version: z.literal(1),
    prefix: chord.nullable(),
    prefixTimeoutMs: z.number().int().min(100).max(60000).nullable(),
    bindings: z.preprocess(
      // Upgrade version 1 files with newly introduced actions, preserving saved bindings.
      (raw) =>
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? {
              "terminal-focus": DEFAULT_KEYBINDINGS.bindings["terminal-focus"],
              ...Object.fromEntries(
                GO_TO_ACTIONS.map(({ id }) => [
                  id,
                  DEFAULT_KEYBINDINGS.bindings[id],
                ]),
              ),
              ...raw,
            }
          : raw,
      z.record(
        z.enum(KEYBINDING_ACTIONS.map((action) => action.id)),
        z.array(binding).max(20),
      ),
    ),
  })
  .superRefine((config, ctx) => {
    for (const issue of validateKeybindings(config))
      ctx.addIssue({ code: "custom", ...issue });
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
      bindings.some((b) =>
        (bindingSequence(b) ?? [bindingChord(b)]).some((chord) =>
          matchesChord(chord, event),
        ),
      ),
    )
  );
}
