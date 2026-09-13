import {
  type FSWatcher,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  defaultKeybindings,
  type KeybindingsState,
  keybindingsConfig,
} from "../shared/keybindings.js";

/** User configuration owned by main, independent of coordinator/UI state. Watch
 * the directory so editors' atomic rename-and-replace saves remain observable. */
export function watchKeybindings(
  env: Record<string, string | undefined>,
  changed: (state: KeybindingsState) => void,
) {
  let state: KeybindingsState = {
    config: defaultKeybindings,
    path: null,
    error: null,
  };
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let coordinatorConfig: KeybindingsState["config"] | null = null;
  const fail = (message: string) => {
    state = {
      ...state,
      config: defaultKeybindings,
      error: `${message}; using default keybindings`,
    };
  };
  const location = z
    .object({
      LOOM_DATA_ROOT: z.string().min(1),
      LOOM_INSTANCE: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    })
    .safeParse(env);
  if (!location.success)
    fail("Set LOOM_DATA_ROOT and LOOM_INSTANCE to edit keybindings");
  else {
    const path = join(
      location.data.LOOM_DATA_ROOT,
      location.data.LOOM_INSTANCE,
      "keybindings.json",
    );
    state.path = path;
    const reload = () => {
      try {
        if (statSync(path).size > 65536) throw new Error("too large");
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        const parsed = keybindingsConfig.safeParse(raw);
        if (parsed.success) state = { path, config: parsed.data, error: null };
        else
          fail(
            "Invalid keybindings.json (check version, actions, chords, duplicates and timeout)",
          );
      } catch {
        // Do not echo untrusted file contents or filesystem errors into logs/UI.
        fail("Cannot read keybindings.json as JSON (maximum 64 KiB)");
      }
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        writeFileSync(
          path,
          `${JSON.stringify(defaultKeybindings, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      watcher = watch(dirname(path), (_event, filename) => {
        if (filename && filename.toString() !== "keybindings.json") return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const previous = JSON.stringify(state);
          reload();
          if (!coordinatorConfig && JSON.stringify(state) !== previous)
            changed(state);
        }, 75);
      });
      watcher.on("error", () => {
        fail("Cannot watch keybindings.json; restart after fixing access");
        changed(state);
      });
      reload();
    } catch {
      fail("Cannot create or watch keybindings.json; check directory access");
    }
  }
  return {
    get: () =>
      coordinatorConfig
        ? { config: coordinatorConfig, path: state.path, error: null }
        : state,
    set: (raw: unknown) => {
      coordinatorConfig = raw === null ? null : keybindingsConfig.parse(raw);
      changed(
        coordinatorConfig
          ? { config: coordinatorConfig, path: state.path, error: null }
          : state,
      );
    },
    close: () => {
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
