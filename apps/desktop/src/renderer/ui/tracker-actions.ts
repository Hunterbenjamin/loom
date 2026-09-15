import { useLayoutEffect } from "react";
import { useStoreApi } from "../store/react.js";
import type { Store } from "../store/store.js";
import type { TrackerActionId } from "./tracker-keymap.js";
export type TrackerActions = Partial<Record<TrackerActionId, () => void>>;
const registrations = new WeakMap<Store, Set<TrackerActions>>();
export function registerTrackerActions(store: Store, actions: TrackerActions) {
  let entries = registrations.get(store);
  if (!entries) {
    entries = new Set();
    registrations.set(store, entries);
  }
  entries.add(actions);
  return () => {
    entries.delete(actions);
  };
}
export function hasTrackerAction(store: Store, id: TrackerActionId): boolean {
  return [...(registrations.get(store) ?? [])].some((actions) => !!actions[id]);
}
export function runTrackerAction(store: Store, id: TrackerActionId): boolean {
  for (const actions of registrations.get(store) ?? []) {
    if (actions[id]) {
      actions[id]();
      return true;
    }
  }
  return false;
}
export function useTrackerActions(actions: TrackerActions) {
  const store = useStoreApi();
  useLayoutEffect(
    () => registerTrackerActions(store, actions),
    [store, actions],
  );
}
