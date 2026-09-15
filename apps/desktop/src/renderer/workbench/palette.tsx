import { KEYBINDING_ACTIONS, type KeybindingAction } from "@loom/core";
import type { PaneView } from "@loom/protocol";
import { Command } from "cmdk";
import { useMemo } from "react";
import {
  formatBindings,
  type KeybindingsState,
} from "../../shared/keybindings.js";
import { useStore, useStoreApi } from "../store/react.js";
import { ChimeMuteCommand } from "./chime.js";
import { DevControlCommands } from "./dev-controls.js";
import { spaces } from "./selectors.js";

export const WorkbenchPalette = ({
  close,
  dispatch,
  openGroup,
  choose,
  scratch,
  bindings,
}: {
  close: () => void;
  dispatch: (action: KeybindingAction) => void;
  openGroup: (rows: PaneView[], name: string) => void;
  choose: (pane: PaneView) => void;
  scratch: () => void;
  bindings: KeybindingsState;
}) => {
  const store = useStoreApi();
  const panes = useStore((state) => state.panes);
  const runs = useStore((state) => state.snapshot.runs);
  const read = useStore((state) => state.readFinished);
  const tree = useMemo(
    () => spaces(panes, "", runs, false, read),
    [panes, runs, read],
  );
  return (
    <div
      className="scrim"
      role="dialog"
      aria-label="Workbench commands"
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="palette">
        <Command label="Workbench commands" loop>
          <button type="button" onClick={close}>
            Close
          </button>
          <Command.Input autoFocus placeholder="Type a command…" />
          <Command.List>
            <DevControlCommands close={close} />
            <ChimeMuteCommand close={close} />
            {KEYBINDING_ACTIONS.map((action) => (
              <Command.Item
                key={action.id}
                onSelect={() => {
                  close();
                  dispatch(action.id);
                }}
              >
                {action.label}{" "}
                <kbd>{formatBindings(bindings.config, action.id)}</kbd>
              </Command.Item>
            ))}
            {tree.map((space) => (
              <Command.Item
                key={`space:${space.key}`}
                value={`space ${space.label} ${space.name} ${space.branch ?? ""}`}
                onSelect={() => {
                  close();
                  const rows =
                    space.tabs[0]?.panes.map((row) => row.pane) ?? [];
                  if (rows.length) openGroup(rows, space.name);
                }}
              >
                Open space {space.label} <kbd>{space.branch ?? ""}</kbd>
              </Command.Item>
            ))}
            {tree
              .flatMap((space) =>
                space.tabs.flatMap((tab) =>
                  tab.panes
                    .filter(
                      ({ pane }) =>
                        (pane.provider || pane.runId || pane.agent) &&
                        !pane.dead,
                    )
                    .map((row) => ({ ...row, space, tab })),
                ),
              )
              .map(({ pane, name, space, tab }) => (
                <Command.Item
                  key={`agent:${pane.id}`}
                  value={`agent ${space.label} ${tab.name} ${name} ${pane.provider ?? pane.agent ?? ""}`}
                  onSelect={() => {
                    close();
                    choose(pane);
                  }}
                >
                  Open agent {space.label} · {name}{" "}
                  <kbd>{pane.provider ?? pane.agent ?? ""}</kbd>
                </Command.Item>
              ))}
            <Command.Item
              onSelect={() => {
                close();
                void scratch();
              }}
            >
              Scratch shell
            </Command.Item>
            <Command.Item
              onSelect={() => void window.loomHost.openWindow("workbench")}
            >
              New Workbench
            </Command.Item>
            <Command.Item
              onSelect={() => {
                close();
                void window.loomHost.setMode("tracker");
              }}
            >
              Switch to issue tracker
            </Command.Item>
            <Command.Item
              onSelect={() => {
                close();
                store.setView("settings");
                void window.loomHost.setMode("tracker");
              }}
            >
              Settings
            </Command.Item>
          </Command.List>
        </Command>
      </div>
    </div>
  );
};
