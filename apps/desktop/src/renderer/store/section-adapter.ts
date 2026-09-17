import { useLayoutEffect, useRef } from "react";
import { useTrackerActions } from "../ui/tracker-actions.js";
import { selectedReviewItems } from "./pull-requests.js";
import {
  retainedCursor,
  runSectionCommand,
  type SectionAdapter,
} from "./section-list.js";
import { selectedListItems } from "./selectors.js";
import type { State, Store } from "./store.js";

export function hasSectionList({ ui }: State): boolean {
  return (
    !ui.openTask &&
    !ui.openPr &&
    !ui.openBrief &&
    !ui.openResearch &&
    (ui.view === "pull-requests" ||
      (ui.pane === "list" &&
        !["needs-you", "briefs", "research", "settings"].includes(ui.view)))
  );
}

function bind<R, S extends string, P extends S>(
  adapter: SectionAdapter<R, S, P>,
) {
  return { run: (action: string) => runSectionCommand(adapter, action) };
}

/** New section pages register their items and actions here; keys need no page-specific rules. */
export function sectionAdapter(store: Store) {
  const state = store.getState();
  if (!hasSectionList(state)) return null;
  if (state.ui.view === "pull-requests")
    return bind({
      items: selectedReviewItems(state),
      cursor: state.ui.prCursor,
      setCursor: store.setPrCursor,
      toggle: store.togglePrSection,
      loadMore: () => store.loadMoreCompletedPrs(),
      open: (row) =>
        store.openPullRequest({ repoId: row.repoId, number: row.number }),
    });
  return bind({
    items: selectedListItems(state),
    cursor: state.ui.cursor,
    setCursor: store.setCursor,
    toggle: store.toggleListSection,
    loadMore: store.loadMoreListSection,
    open: (row) => store.open(row.task.id),
  });
}

/** Component-local projections share the same navigation and identity retention as store lists. */
export function useSectionAdapter<R, S extends string, P extends S>(
  adapter: SectionAdapter<R, S, P>,
  enabled: boolean,
) {
  const previous = useRef(adapter.items);
  const cursor =
    previous.current === adapter.items
      ? adapter.cursor
      : retainedCursor(adapter.items, previous.current[adapter.cursor ?? -1]);
  useLayoutEffect(() => {
    previous.current = adapter.items;
    if (cursor !== adapter.cursor) adapter.setCursor(cursor);
  }, [adapter, cursor]);
  const actions = [
    "next-row",
    "previous-row",
    "first-row",
    "last-row",
    "open",
    "expand-item",
    "collapse-section",
    "next-section",
    "previous-section",
  ] as const;
  useTrackerActions(
    enabled
      ? Object.fromEntries(
          actions.map((action) => [
            action,
            () => {
              runSectionCommand({ ...adapter, cursor }, action);
            },
          ]),
        )
      : {},
  );
  return cursor;
}
