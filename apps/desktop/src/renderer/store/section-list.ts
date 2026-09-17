/** Every cursor stop has an identity and an owning section, independent of its row data. */
export type SectionItem<R, S extends string = string, P extends S = S> = {
  key: string;
  section: S;
} & (
  | { kind: "header"; count: number; collapsed: boolean }
  | { kind: "load-more"; section: P; count: number }
  | { kind: "row"; row: R }
);

type Item = SectionItem<unknown>;
const indices = new WeakMap<
  readonly Item[],
  {
    keys: Map<string, number>;
    headers: Map<string, number>;
  }
>();

/** Build once with the items, never scan rows when navigating out of a section. */
export function indexSectionItems<T extends Item>(items: T[]): T[] {
  const keys = new Map<string, number>();
  const headers = new Map<string, number>();
  items.forEach((item, index) => {
    keys.set(item.key, index);
    if (item.kind === "header") headers.set(item.section, index);
  });
  indices.set(items, { keys, headers });
  return items;
}

function indexFor(items: readonly Item[]) {
  const index = indices.get(items);
  if (!index) throw new Error("Section items must be indexed when produced");
  return index;
}

export const listItemKey = (item: Item): string => item.key;

export function retainedCursor(
  items: readonly Item[],
  selected: Item | undefined,
): number | null {
  if (!selected) return null;
  const index = indexFor(items);
  return (
    index.keys.get(selected.key) ?? index.headers.get(selected.section) ?? null
  );
}

export function moveCursor(
  length: number,
  cursor: number | null,
  action: "next-row" | "previous-row" | "first-row" | "last-row",
): number | null {
  if (!length) return null;
  if (action === "first-row") return 0;
  if (action === "last-row") return length - 1;
  return cursor === null
    ? 0
    : Math.max(
        0,
        Math.min(length - 1, cursor + (action === "next-row" ? 1 : -1)),
      );
}

export function sectionHeader(
  items: readonly Item[],
  cursor: number | null,
): number | null {
  const item = items[cursor ?? -1];
  return item ? (indexFor(items).headers.get(item.section) ?? null) : null;
}

export function jumpSection(
  items: readonly Item[],
  cursor: number | null,
  direction: 1 | -1,
): number | null {
  let previous: number | null = null;
  for (const index of indexFor(items).headers.values()) {
    if (direction === 1 && index > (cursor ?? -1)) return index;
    if (direction === -1 && index < (cursor ?? items.length)) previous = index;
  }
  return direction === -1 ? (previous ?? cursor) : cursor;
}

export function activation<T extends Item>(item: T | undefined): T | undefined {
  return item?.kind === "header" && !item.collapsed ? undefined : item;
}

export interface SectionAdapter<R, S extends string, P extends S> {
  items: SectionItem<R, S, P>[];
  cursor: number | null;
  setCursor(cursor: number | null): void;
  toggle(section: S): void;
  loadMore(section: P): void;
  open(row: R): void;
}

/** Shared dispatch; page adapters only provide data and store actions. */
export function runSectionCommand<R, S extends string, P extends S>(
  adapter: SectionAdapter<R, S, P>,
  action: string,
): boolean {
  const { items, cursor, setCursor } = adapter;
  switch (action) {
    case "next-row":
    case "previous-row":
    case "first-row":
    case "last-row":
      setCursor(moveCursor(items.length, cursor, action));
      return true;
    case "next-section":
    case "previous-section":
      setCursor(jumpSection(items, cursor, action === "next-section" ? 1 : -1));
      return true;
    case "collapse-section": {
      const header = sectionHeader(items, cursor);
      if (header !== null) {
        setCursor(header);
        adapter.toggle(items[header]!.section);
      }
      return true;
    }
    case "open":
    case "expand-item": {
      const item = activation(items[cursor ?? -1]);
      if (item?.kind === "row") adapter.open(item.row);
      else if (item?.kind === "header") adapter.toggle(item.section);
      else if (item?.kind === "load-more") {
        adapter.loadMore(item.section);
        // The first inserted row occupies the previous load-more stop.
        setCursor(cursor);
      }
      return true;
    }
    default:
      return false;
  }
}
