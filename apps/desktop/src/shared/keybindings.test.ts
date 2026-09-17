import { KEYBINDING_ACTIONS, matchesChord } from "@loom/core";
import { expect, test } from "vitest";
import {
  defaultKeybindings,
  formatBindings,
  keybindingsConfig,
  usesWorkbenchKey,
} from "./keybindings.js";

test("the editable defaults include every action, direct Mac chords and legacy suffixes", () => {
  expect(
    keybindingsConfig.parse(JSON.parse(JSON.stringify(defaultKeybindings))),
  ).toEqual(defaultKeybindings);
  expect(Object.keys(defaultKeybindings.bindings)).toEqual(
    KEYBINDING_ACTIONS.map((action) => action.id),
  );
  expect(defaultKeybindings.prefixTimeoutMs).toBe(3000);
  expect(defaultKeybindings.bindings["terminal-focus"]).toEqual(["Prefix q"]);
  expect(defaultKeybindings.bindings.close).toEqual(["Cmd+W", "Prefix x"]);
  expect(formatBindings(defaultKeybindings, "split-right")).toBe(
    "Cmd+D / Ctrl+Space then |",
  );
  expect(
    KEYBINDING_ACTIONS.filter((action) => action.id.startsWith("agent-")).map(
      ({ label }) => label,
    ),
  ).toEqual([
    "Main",
    "Agent 1",
    "Agent 2",
    "Agent 3",
    "Agent 4",
    "Agent 5",
    "Agent 6",
    "Agent 7",
    "Agent 8",
  ]);
});

test("strict boundary rejects malformed, incomplete, ambiguous and unreachable configuration", () => {
  const config = () => structuredClone(defaultKeybindings);
  const invalid: unknown[] = [
    null,
    {},
    { ...config(), version: 2 },
    { ...config(), extra: true },
  ];
  for (const prefixTimeoutMs of [0, -1, 1.5, 60001, "3000"])
    invalid.push({ ...config(), prefixTimeoutMs });
  for (const value of [
    "Cmd+Bogus",
    "Ctrl+Ctrl+D",
    "Cmd++",
    "Prefix ",
    "Cmd+J",
    "Cmd+Shift+W",
    "Ctrl+Space",
    "Cmd+T",
    "Prefix Escape",
    "Prefix Cmd+Shift+W",
    "Prefix h",
  ])
    invalid.push({
      ...config(),
      bindings: { ...config().bindings, help: [value] },
    });
  invalid.push({
    ...config(),
    bindings: { ...config().bindings, unknown: [] },
  });
  const missing = config();
  Reflect.deleteProperty(missing.bindings, "help");
  invalid.push(
    missing,
    { ...config(), prefix: null },
    { ...config(), prefix: "Cmd+J" },
  );
  for (const raw of invalid)
    expect(keybindingsConfig.safeParse(raw).success).toBe(false);
});

test("bindings can be replaced, disabled or reduced to direct chords including literal Ctrl+A", () => {
  const config = structuredClone(defaultKeybindings);
  config.prefix = null;
  for (const action of KEYBINDING_ACTIONS) config.bindings[action.id] = [];
  config.bindings.literal = ["Ctrl+A"];
  config.bindings.new = ["Ctrl+Shift+T"];
  expect(keybindingsConfig.parse(config)).toEqual(config);
  expect(formatBindings(config, "close")).toBe("Unbound");
});

test("native menu arbitration recognizes every configured chord and preserves unbound edit shortcuts", () => {
  const key = (key: string, shiftKey = false) => ({
    key,
    shiftKey,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
  });
  for (const event of [
    key("d"),
    key("D", true),
    key("w"),
    key("t"),
    key("]", true),
    key("}", true),
    key("[", true),
    key("Enter", true),
    key("p"),
    { ...key("ArrowLeft"), altKey: true },
  ])
    expect(usesWorkbenchKey(defaultKeybindings, event)).toBe(true);
  for (const k of ["c", "v", "q", "j"])
    expect(usesWorkbenchKey(defaultKeybindings, key(k))).toBe(false);
  expect(matchesChord("Cmd+D", { ...key("d"), ctrlKey: true })).toBe(false);
  expect(matchesChord("Prefix ?", key("?"))).toBe(false);
});

test("version 1 bindings gain terminal exit while retaining custom and unbound actions", () => {
  const config = structuredClone(defaultKeybindings);
  config.bindings.new = ["Cmd+U"];
  config.bindings.close = [];
  Reflect.deleteProperty(config.bindings, "terminal-focus");
  expect(keybindingsConfig.parse(config).bindings).toEqual({
    ...config.bindings,
    "terminal-focus": ["Prefix q"],
  });
});
