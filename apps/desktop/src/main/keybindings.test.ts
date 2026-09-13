import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { defaultKeybindings } from "../shared/keybindings.js";
import { watchKeybindings } from "./keybindings.js";

test("first run writes the full defaults; watcher follows saves, invalid files, deletion and atomic replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-keybindings-"));
  const env = { LOOM_DATA_ROOT: root, LOOM_INSTANCE: "dev" };
  const changed = vi.fn();
  const watcher = watchKeybindings(env, changed);
  const path = join(root, "dev", "keybindings.json");
  try {
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(defaultKeybindings);
    expect(watcher.get()).toEqual({
      path,
      config: defaultKeybindings,
      error: null,
    });
    const config = structuredClone(defaultKeybindings);
    config.bindings.help = ["Ctrl+Shift+H"];
    config.prefixTimeoutMs = 4500;
    writeFileSync(path, JSON.stringify(config));
    await vi.waitFor(() => expect(watcher.get().config).toEqual(config));
    expect(changed).toHaveBeenLastCalledWith(watcher.get());
    writeFileSync(path, '{"secret-not-for-ui":');
    await vi.waitFor(() => expect(watcher.get().error).not.toBeNull());
    expect(watcher.get().config).toEqual(defaultKeybindings);
    expect(watcher.get().error).not.toContain("secret-not-for-ui");
    writeFileSync(`${path}.tmp`, JSON.stringify(config));
    renameSync(`${path}.tmp`, path);
    await vi.waitFor(() => expect(watcher.get().config).toEqual(config));
    expect(watcher.get().error).toBeNull();
    unlinkSync(path);
    await vi.waitFor(() => expect(watcher.get().error).not.toBeNull());
    expect(watcher.get().config).toEqual(defaultKeybindings);
    writeFileSync(path, JSON.stringify(config));
    await vi.waitFor(() => expect(watcher.get().config).toEqual(config));
    const reopened = watchKeybindings(env, vi.fn());
    expect(reopened.get().config).toEqual(config);
    reopened.close();
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unconfigured / path-traversing instances do not write a file", () => {
  for (const env of [
    {},
    { LOOM_DATA_ROOT: tmpdir(), LOOM_INSTANCE: "../stable" },
  ]) {
    const watcher = watchKeybindings(env, vi.fn());
    expect(watcher.get().path).toBeNull();
    expect(watcher.get().error).not.toBeNull();
    expect(watcher.get().config).toEqual(defaultKeybindings);
    watcher.close();
  }
});
