import { expect, test, vi } from "vitest";
import { OwnedResources } from "./ownership.js";

test("same panel ID in two windows owns independent resources", () => {
  const dispose = vi.fn();
  const owners = new OwnedResources<string>(dispose);
  owners.open(1);
  owners.open(2);
  owners.finish(1, "p", owners.begin(1, "p"), "one");
  owners.finish(2, "p", owners.begin(2, "p"), "two");
  expect(owners.get(3, "p")).toBeUndefined();
  owners.kill(1, "p");
  expect(dispose.mock.calls).toEqual([["one"]]);
  expect(owners.get(2, "p")).toBe("two");
  owners.close(1);
  expect(owners.get(2, "p")).toBe("two");
  owners.close(2);
  expect(dispose).toHaveBeenCalledWith("two");
});
test("close/crash, cancellation and superseding spawns dispose late completion; old exits cannot delete replacements", () => {
  const dispose = vi.fn();
  const owners = new OwnedResources<string>(dispose);
  owners.open(1);
  const old = owners.begin(1, "p");
  const current = owners.begin(1, "p");
  expect(owners.finish(1, "p", old, "old")).toBe(false);
  owners.finish(1, "p", current, "current");
  expect(owners.delete(1, "p", "old")).toBe(false);
  expect(owners.get(1, "p")).toBe("current");
  const pending = owners.begin(1, "pending");
  owners.close(1);
  expect(owners.finish(1, "pending", pending, "late")).toBe(false);
  expect(dispose.mock.calls).toEqual([["old"], ["current"], ["late"]]);
  expect(() => owners.begin(1, "p")).toThrow("Unknown window");
});
