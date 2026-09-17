import { expect, test, vi } from "vitest";
import {
  activation,
  indexSectionItems,
  jumpSection,
  moveCursor,
  retainedCursor,
  runSectionCommand,
  type SectionItem,
  sectionHeader,
} from "./section-list.js";

const header = (section: string, collapsed = false): SectionItem<string> => ({
  kind: "header",
  section,
  key: `header-${section}`,
  count: 1,
  collapsed,
});
const row: SectionItem<string> = {
  kind: "row",
  section: "a",
  key: "row-a",
  row: "A",
};
const more: SectionItem<string> = {
  kind: "load-more",
  section: "a",
  key: "more-a",
  count: 20,
};
const items = indexSectionItems([header("a"), row, more, header("b", true)]);

test("movement visits all stops and bounds empty, unset and stale cursors", () => {
  expect(moveCursor(0, null, "next-row")).toBeNull();
  expect(moveCursor(4, null, "previous-row")).toBe(0);
  expect(moveCursor(4, 0, "previous-row")).toBe(0);
  expect(moveCursor(4, 1, "next-row")).toBe(2);
  expect(moveCursor(4, 99, "next-row")).toBe(3);
  expect(moveCursor(4, 2, "first-row")).toBe(0);
  expect(moveCursor(4, 0, "last-row")).toBe(3);
});

test("section jumps use headers from rows, headers and load-more", () => {
  for (const cursor of [0, 1, 2]) expect(jumpSection(items, cursor, 1)).toBe(3);
  expect(jumpSection(items, 3, 1)).toBe(3);
  expect(jumpSection(items, 3, -1)).toBe(0);
  expect(jumpSection(items, 1, -1)).toBe(0);
  expect(jumpSection(items, null, 1)).toBe(0);
  expect(jumpSection(items, null, -1)).toBe(3);
  expect(sectionHeader(items, 2)).toBe(0);
  expect(sectionHeader(items, null)).toBeNull();
});

test("activation and toggling have one definition for every item kind", () => {
  expect(activation(items[0])).toBeUndefined();
  expect(activation(items[3])).toBe(items[3]);
  expect(activation(row)).toBe(row);
  expect(activation(more)).toBe(more);
  const adapter = {
    items,
    cursor: 1,
    setCursor: vi.fn(),
    toggle: vi.fn(),
    loadMore: vi.fn(),
    open: vi.fn(),
  };
  runSectionCommand(adapter, "collapse-section");
  expect(adapter.setCursor).toHaveBeenLastCalledWith(0);
  expect(adapter.toggle).toHaveBeenLastCalledWith("a");
  adapter.cursor = 3;
  runSectionCommand(adapter, "collapse-section");
  expect(adapter.toggle).toHaveBeenLastCalledWith("b");
  adapter.cursor = 1;
  runSectionCommand(adapter, "open");
  expect(adapter.open).toHaveBeenCalledWith("A");
  adapter.cursor = 2;
  runSectionCommand(adapter, "expand-item");
  expect(adapter.loadMore).toHaveBeenCalledWith("a");
  expect(adapter.setCursor).toHaveBeenLastCalledWith(2);
});

test("retention prefers identity, then the owning header, then clears selection", () => {
  expect(retainedCursor(items, row)).toBe(1);
  expect(
    retainedCursor(indexSectionItems([header("a", true), header("b")]), row),
  ).toBe(0);
  expect(retainedCursor(indexSectionItems([header("b")]), row)).toBeNull();
  expect(retainedCursor(items, undefined)).toBeNull();
});

test("jumps and header lookup never read intervening rows", () => {
  const large = indexSectionItems([
    header("a"),
    ...Array.from({ length: 10000 }, (_, i) => ({ ...row, key: `row-${i}` })),
    header("b"),
  ]);
  for (let i = 1; i < large.length - 1; i++)
    Object.defineProperty(large, i, {
      get() {
        throw new Error("Scanned a row");
      },
    });
  expect(jumpSection(large, 0, 1)).toBe(10001);
  expect(jumpSection(large, 10001, -1)).toBe(0);
  expect(sectionHeader(large, 10001)).toBe(10001);
});
