import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { State, Store } from "./store.js";

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: Store;
  children: ReactNode;
}) {
  return (
    <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
  );
}

export function useStoreApi(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStoreApi outside a StoreProvider");
  return store;
}

/**
 * Subscribe to one slice. The cached comparison keeps a panel from re-rendering when some
 * other panel's slice changed, which is what keeps view switches inside the 50 ms budget.
 */
export function useStore<T>(
  select: (state: State) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useStoreApi();
  const cache = useRef<{ value: T } | null>(null);
  const read = () => {
    const next = select(store.getState());
    if (cache.current && equal(cache.current.value, next))
      return cache.current.value;
    cache.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

export function shallowArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
