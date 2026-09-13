import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { windowMode } from "../shared/ipc.js";
import { keybindingsConfig } from "../shared/keybindings.js";

export const nativeSettings = z.strictObject({
  version: z.literal(1),
  windowMode,
  terminalHistoryLimit: z.number().int().positive(),
  keybindings: keybindingsConfig,
});
export type NativeSettings = z.output<typeof nativeSettings>;

function location(env: Record<string, string | undefined>): string | null {
  const parsed = z
    .object({
      LOOM_DATA_ROOT: z.string().min(1),
      LOOM_INSTANCE: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    })
    .safeParse(env);
  return parsed.success
    ? join(
        parsed.data.LOOM_DATA_ROOT,
        parsed.data.LOOM_INSTANCE,
        "desktop-settings.json",
      )
    : null;
}

/** Derived startup cache only. The coordinator settings row remains authoritative. */
export function readNativeSettings(
  env: Record<string, string | undefined>,
): NativeSettings | null {
  const path = location(env);
  if (!path) return null;
  try {
    return nativeSettings.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeNativeSettings(
  env: Record<string, string | undefined>,
  raw: unknown,
): NativeSettings {
  const value = nativeSettings.parse(raw);
  const path = location(env);
  if (!path)
    throw new Error("Desktop settings need LOOM_DATA_ROOT and LOOM_INSTANCE");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
  return value;
}
