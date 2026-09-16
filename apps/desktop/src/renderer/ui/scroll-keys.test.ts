// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { createScrollMatcher, scrollBindings } from "./scroll-keys.js";

test("every reading binding matches, including the two-key top sequence", () => {
  for (const entry of scrollBindings) {
    for (const binding of entry.keys) {
      const matcher = createScrollMatcher(true);
      for (const [index, key] of binding.split(" ").entries()) {
        const parts = key.split("+");
        const last = parts.at(-1)!;
        const result = matcher.match(
          new KeyboardEvent("keydown", {
            key: last === "Space" ? " " : last,
            ctrlKey: parts.includes("Control"),
            shiftKey: parts.includes("Shift") || last === "G",
          }),
        );
        expect(result).toBe(
          binding.includes(" ") && index === 0 ? "pending" : entry.id,
        );
      }
    }
  }
});
test("plain keys do not match with modifiers, and q types in chat", () => {
  for (const key of ["j", "k", "g", "G", "q", " "]) {
    for (const modifier of ["metaKey", "altKey", "ctrlKey"])
      expect(
        createScrollMatcher(true).match(
          new KeyboardEvent("keydown", { key, [modifier]: true }),
        ),
      ).toBeNull();
  }
  expect(
    createScrollMatcher().match(new KeyboardEvent("keydown", { key: "q" })),
  ).toBeNull();
});
