import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { defaultKeybindings } from "../shared/keybindings.js";
import { readNativeSettings, writeNativeSettings } from "./native-settings.js";

test("native settings cache round-trips coordinator-owned startup values", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-native-settings-"));
  const env = { LOOM_DATA_ROOT: root, LOOM_INSTANCE: "dev" };
  const value = {
    version: 1 as const,
    windowMode: "workbench" as const,
    terminalHistoryLimit: 42_000,
    keybindings: defaultKeybindings,
  };
  try {
    expect(readNativeSettings(env)).toBeNull();
    expect(writeNativeSettings(env, value)).toEqual(value);
    expect(readNativeSettings(env)).toEqual(value);
    expect(() =>
      writeNativeSettings(env, { ...value, terminalHistoryLimit: 0 }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
