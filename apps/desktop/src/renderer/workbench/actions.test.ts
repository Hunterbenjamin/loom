import { expect, test, vi } from "vitest";
import { actions, prefixKeys } from "./actions.js";

const key = (key: string, ctrlKey = false) => ({
  key,
  ctrlKey,
  metaKey: false,
  altKey: false,
  type: "keydown",
});
test("each palette action has one prefix binding and consumed bytes dispatch exactly once", () => {
  const dispatch = vi.fn(),
    literal = vi.fn();
  const handle = prefixKeys(dispatch, literal);
  expect(new Set(actions.map((a) => a.key)).size).toBe(13);
  for (const a of actions) {
    expect(handle(key("a", true))).toBe(true);
    expect(handle(key(a.key))).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith(a.id);
  }
  expect(dispatch).toHaveBeenCalledTimes(13);
  expect(handle(key("a", true))).toBe(true);
  expect(handle(key("a", true))).toBe(true);
  expect(literal).toHaveBeenCalledTimes(1);
});
test("timeout, Escape, unknown commands and ordinary keys preserve normal terminal input", () => {
  let time = 0;
  const dispatch = vi.fn();
  const handle = prefixKeys(dispatch, vi.fn(), () => time);
  expect(handle(key("x"))).toBe(false);
  handle(key("a", true));
  time = 1501;
  expect(handle(key("x"))).toBe(false);
  handle(key("a", true));
  expect(handle(key("Escape"))).toBe(true);
  expect(handle(key("x"))).toBe(false);
  handle(key("a", true));
  expect(handle(key("q"))).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});
