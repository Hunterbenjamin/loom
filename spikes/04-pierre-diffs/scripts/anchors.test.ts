import { test } from "node:test";
import assert from "node:assert/strict";
import { capture, relocate } from "../src/anchors.ts";

const original = ["one", "two", "target", "four", "five"];
const anchor = capture(original, 3);
test("unchanged anchor retains identity", () =>
  assert.deepEqual(relocate(anchor, original), { status: "exact", line: 3 }));
test("insertion above moves the anchor", () =>
  assert.deepEqual(relocate(anchor, ["new", ...original]), { status: "moved", line: 4 }));
test("deleted or edited target becomes outdated", () => {
  assert.deepEqual(relocate(anchor, ["one", "two", "four", "five"]), { status: "outdated" });
  assert.deepEqual(relocate(anchor, ["one", "two", "changed", "four", "five"]), {
    status: "outdated",
  });
});
test("duplicate blocks refuse an arbitrary match", () =>
  assert.deepEqual(relocate(anchor, [...original, ...original]), { status: "ambiguous" }));
test("context disambiguates repeated line text", () =>
  assert.deepEqual(relocate(anchor, ["target", ...original]), { status: "moved", line: 4 }));
test("blank lines do not become confident anchors", () =>
  assert.deepEqual(relocate(capture([""], 1), ["", ""]), { status: "ambiguous" }));
