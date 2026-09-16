import { afterEach, expect, test, vi } from "vitest";
import { defaultKeybindings } from "../../shared/keybindings.js";
import { bindingMatcher } from "./actions.js";

const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  type: "keydown",
  ...modifiers,
});
const prefix = key(" ", { ctrlKey: true });
afterEach(() => vi.useRealTimers());
function harness(config = defaultKeybindings) {
  vi.useFakeTimers();
  const dispatch = vi.fn(),
    armed = vi.fn();
  return { ...bindingMatcher(config, dispatch, armed), dispatch, armed };
}
test("all legacy suffixes dispatch once, including Shift keydown before | and ?", () => {
  const h = harness();
  const suffixes = [
    "|",
    "-",
    "h",
    "j",
    "k",
    "l",
    "c",
    "n",
    "p",
    "x",
    "z",
    "g",
    "?",
  ];
  for (const suffix of suffixes) {
    expect(h.handle(prefix)).toBe(true);
    const shiftKey = suffix === "|" || suffix === "?";
    if (shiftKey) expect(h.handle(key("Shift", { shiftKey }))).toBe(false);
    expect(h.handle(key(suffix, { shiftKey }))).toBe(true);
    expect(h.armed).toHaveBeenLastCalledWith(false);
  }
  expect(h.dispatch.mock.calls.map(([id]) => id)).toEqual([
    "split-right",
    "split-down",
    "left",
    "down",
    "up",
    "right",
    "new",
    "next",
    "previous",
    "close",
    "zoom",
    "jump",
    "help",
  ]);
  h.cancel();
});

test("direct chords use exact modifiers, including shifted bracket variants and terminal zoom", () => {
  const h = harness();
  for (const [event, action] of [
    [key("d", { metaKey: true }), "split-right"],
    [key("D", { metaKey: true, shiftKey: true }), "split-down"],
    [key("ArrowRight", { metaKey: true, altKey: true }), "right"],
    [key("}", { metaKey: true, shiftKey: true }), "next"],
    [key("]", { metaKey: true, shiftKey: true }), "next"],
    [key("Enter", { metaKey: true, shiftKey: true }), "zoom"],
  ] as const) {
    expect(h.handle(event)).toBe(true);
    expect(h.dispatch).toHaveBeenLastCalledWith(action);
  }
  expect(h.handle(key("d", { metaKey: true, ctrlKey: true }))).toBe(false);
  expect(h.handle(key("d"))).toBe(false);
  h.cancel();
});

test("expiry updates the indicator without another key; Escape and unknown suffixes cancel", () => {
  const h = harness();
  h.handle(prefix);
  vi.advanceTimersByTime(2999);
  expect(h.armed).toHaveBeenLastCalledWith(true);
  vi.advanceTimersByTime(1);
  expect(h.armed).toHaveBeenLastCalledWith(false);
  expect(h.handle(key("x"))).toBe(false);
  h.handle(prefix);
  expect(h.handle(key("Escape"))).toBe(true);
  expect(h.handle(key("x"))).toBe(false);
  h.handle(prefix);
  expect(h.handle(key("q"))).toBe(true);
  expect(h.handle(key("x"))).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.cancel();
});

test("literal Ctrl+A, repeats, composition and keyup never accidentally dispatch a command", () => {
  const h = harness();
  h.handle(prefix);
  expect(h.handle({ ...prefix, repeat: true })).toBe(true);
  expect(h.handle({ ...prefix, type: "keyup" })).toBe(false);
  expect(h.handle(key("Control", { ctrlKey: true }))).toBe(false);
  expect(h.handle(prefix)).toBe(true);
  expect(h.dispatch).toHaveBeenCalledExactlyOnceWith("literal");
  expect(h.handle(key("t", { metaKey: true, isComposing: true }))).toBe(false);
  expect(h.handle(key("t", { metaKey: true, repeat: true }))).toBe(true);
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  h.cancel();
});

test("custom prefix, timeout and direct literal are honored; expiry is checked even before the timer runs", () => {
  const config = structuredClone(defaultKeybindings);
  config.prefix = "Ctrl+B";
  config.prefixTimeoutMs = 5000;
  config.bindings.literal = ["Ctrl+Space", "Prefix Ctrl+B"];
  let now = 0;
  const dispatch = vi.fn();
  const h = bindingMatcher(config, dispatch, vi.fn(), () => now);
  expect(h.handle(prefix)).toBe(true);
  expect(dispatch).toHaveBeenLastCalledWith("literal");
  h.handle(key("b", { ctrlKey: true }));
  now = 4000;
  expect(h.handle(key("z"))).toBe(true);
  expect(dispatch).toHaveBeenLastCalledWith("zoom");
  h.handle(key("b", { ctrlKey: true }));
  now = 9000;
  expect(h.handle(key("z"))).toBe(false);
  h.cancel();
});
