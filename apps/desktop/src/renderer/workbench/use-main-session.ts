import type { RepoId } from "@loom/core";
import type { LeadTarget, PaneIdentity, PaneView } from "@loom/protocol";
import { useEffect, useRef, useState } from "react";
import type { useStoreApi } from "../store/react.js";
import { sameTerminal } from "./selectors.js";
import { identity, type Panel } from "./tabs.js";

type Store = ReturnType<typeof useStoreApi>;

const canonicalPane = (panes: PaneView[], target: LeadTarget) =>
  target.pane
    ? panes.find((pane) => sameTerminal(pane, target.pane as PaneIdentity))
    : undefined;

/** Inventory and command acknowledgements share a socket but are separate frames. */
const waitForCanonicalPane = (
  store: Store,
  target: LeadTarget,
): Promise<PaneView | undefined> => {
  const current = canonicalPane(store.getState().panes, target);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const finish = (pane?: PaneView) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(pane);
    };
    const unsubscribe = store.subscribe(() => {
      const pane = canonicalPane(store.getState().panes, target);
      if (pane) finish(pane);
    });
    const timer = setTimeout(() => finish(), 1_500);
  });
};

export const useMainSession = ({
  store,
  repo,
  selectedPanel,
  openGroup,
  onError,
}: {
  store: Store;
  repo: string;
  selectedPanel?: Panel;
  openGroup: (rows: PaneView[], name: string) => void;
  onError: (error: string) => void;
}) => {
  const pinnedRequest = useRef(0);
  const mainSelected = useRef(false);
  const openPinnedRef = useRef<(system: "main") => void>(() => {});
  const [mainTarget, setMainTarget] = useState<{
    repo: string;
    sessionId: string;
    pane: PaneIdentity;
  } | null>(null);

  const openPinned = (system: "main") => {
    const state = store.getState();
    // Opening Main counts as looking at it: its finished dot clears.
    if (system === "main") store.markMainRead();
    // A live Main is just opened, like any pane: no command, so nothing is asked of it. The
    // coordinator is only involved when there is no live pane or Main is stopped.
    if (system === "main" && state.lead.status !== "stopped") {
      const existing = state.panes.find(
        (pane) =>
          pane.sessionName === `loom-lead-${state.ui.repo}` && !pane.dead,
      );
      if (existing) {
        if (state.lead.sessionId)
          setMainTarget({
            repo: state.ui.repo,
            sessionId: state.lead.sessionId,
            pane: identity(existing),
          });
        return openGroup([existing], system);
      }
    }
    const requestedRepo = state.ui.repo;
    const request = ++pinnedRequest.current;
    void store
      .command({ kind: "open_lead_session", repoId: requestedRepo as RepoId })
      .then(async (result) => {
        if (!result.ok) throw new Error(result.error.message);
        if (
          result.result.kind !== "attach_session" ||
          !("identity" in result.result.target) ||
          result.result.target.identity !== "lead" ||
          result.result.target.repoId !== requestedRepo ||
          !result.result.target.pane ||
          result.result.target.pane.dead
        )
          throw new Error("Coordinator returned an invalid Main target");
        const target = result.result.target;
        const sessionId = target.sessionId;
        if (!sessionId)
          throw new Error("Coordinator returned a Main without a session");
        const pane = await waitForCanonicalPane(store, target);
        if (
          request !== pinnedRequest.current ||
          store.getState().ui.repo !== requestedRepo
        )
          return;
        if (!pane || pane.dead || pane.unavailable)
          throw new Error("Main terminal is not available yet");
        setMainTarget({
          repo: requestedRepo,
          sessionId,
          pane: identity(pane),
        });
        openGroup([pane], system);
      })
      .catch((error) => onError(String(error)));
  };
  openPinnedRef.current = openPinned;
  mainSelected.current = !!(
    selectedPanel?.target &&
    mainTarget &&
    sameTerminal(selectedPanel.target, mainTarget.pane)
  );

  useEffect(() => {
    pinnedRequest.current += 1;
    setMainTarget((target) => (target?.repo === repo ? target : null));
    if (mainSelected.current) openPinnedRef.current("main");
  }, [repo]);

  return { mainTarget, openPinned };
};
