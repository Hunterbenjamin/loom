import { displayName } from "@loom/core";
import { Command, defaultFilter } from "cmdk";
import { useEffect, useLayoutEffect, useState } from "react";
import { selectedDetailTask } from "../store/detail-selection.js";
import { inboxRows } from "../store/inbox.js";
import { useStore, useStoreApi } from "../store/react.js";
import {
  cursorItems,
  issueKeyFor,
  type Row,
  selectedRows,
} from "../store/selectors.js";
import type { State } from "../store/store.js";
import { VIEWS } from "../store/ui-state.js";
import { ChimeMuteCommand } from "../workbench/chime.js";
import { CREATABLES } from "./creatables.js";
import { STAGES, stageLabel } from "./format.js";
import { runTrackerCommand } from "./keys.js";
import { PullRequestPaletteCommands } from "./pull-request-commands.js";
import { hasTrackerAction, runTrackerAction } from "./tracker-actions.js";
import { formatKeys, trackerKeymap } from "./tracker-keymap.js";

/** Issue commands always target the active detail or the visible issue cursor. */
export function paletteIssueTarget(state: State) {
  const { ui } = state;
  if (ui.openTask || ui.openPr) return selectedDetailTask(state)?.id ?? null;
  if (
    ui.openBrief ||
    ui.openResearch ||
    ["briefs", "research", "settings", "pull-requests"].includes(ui.view)
  )
    return null;
  if (ui.view === "needs-you" && ui.pane === "list")
    return inboxRows(state)[ui.cursor ?? -1]?.task.id ?? null;
  const item = cursorItems(state)[ui.cursor ?? -1];
  return item?.kind === "row" ? item.row.task.id : null;
}

export const paletteIssueValue = (
  row: Row,
  repos: State["snapshot"]["repos"],
) =>
  `${issueKeyFor(row.task, repos)} ${row.task.number} ${row.task.name ?? ""} ${row.task.title}`;

export function paletteIssueRows(
  rows: Row[],
  repos: State["snapshot"]["repos"],
  query: string,
) {
  const search = query.trim();
  if (!search) return rows.slice(0, 60);
  return rows
    .map((row) => ({
      row,
      score: defaultFilter(paletteIssueValue(row, repos), search),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .map(({ row }) => row);
}

export function Palette() {
  const store = useStoreApi();
  const open = useStore((s) => s.ui.palette);
  const rows = useStore(selectedRows);
  const current = useStore(paletteIssueTarget);
  const canToggleView = useStore(
    (s) =>
      !s.ui.openTask &&
      !s.ui.openPr &&
      !s.ui.openBrief &&
      !s.ui.openResearch &&
      ["all", "needs-you"].includes(s.ui.view),
  );
  const pane = useStore((s) => s.ui.pane);
  const canNavigateSections = useStore(
    (s) =>
      s.ui.pane === "list" &&
      s.ui.view !== "needs-you" &&
      !["briefs", "research", "settings", "pull-requests"].includes(
        s.ui.view,
      ) &&
      !s.ui.openTask &&
      !s.ui.openPr,
  );
  const repos = useStore((s) => s.snapshot.repos);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  if (!open) return null;
  const close = () => store.setPalette(false);
  const run = (action: () => void) => {
    close();
    action();
  };

  return (
    <Scrim onClose={close}>
      <Command label="Command palette" loop>
        <Command.Input
          autoFocus
          value={value}
          onValueChange={setValue}
          placeholder="Type a command, or an issue to open…"
        />
        <Command.List>
          <Command.Empty>Nothing matches.</Command.Empty>

          <Command.Group heading="Go to">
            {VIEWS.map((view) => (
              <Command.Item
                key={view.id}
                onSelect={() =>
                  run(() => runTrackerCommand(store, `go-${view.id}`))
                }
              >
                {view.label} <kbd>{formatKeys(`go-${view.id}`)}</kbd>
              </Command.Item>
            ))}
            <Command.Item
              disabled={!canToggleView}
              onSelect={() => run(() => runTrackerCommand(store, "view"))}
            >
              Switch to {pane === "list" ? "board" : "list"}{" "}
              <kbd>{formatKeys("view")}</kbd>
            </Command.Item>
          </Command.Group>

          <Command.Group heading="More sections">
            <Command.Item
              onSelect={() => run(() => runTrackerCommand(store, "go-briefs"))}
            >
              Daily brief <kbd>{formatKeys("go-briefs")}</kbd>
            </Command.Item>
            <Command.Item
              onSelect={() =>
                run(() => runTrackerCommand(store, "go-research"))
              }
            >
              Research <kbd>{formatKeys("go-research")}</kbd>
            </Command.Item>
            <Command.Item
              onSelect={() =>
                run(() => runTrackerCommand(store, "go-settings"))
              }
            >
              Settings <kbd>{formatKeys("go-settings")}</kbd>
            </Command.Item>
          </Command.Group>

          <PullRequestPaletteCommands close={close} />
          <Command.Group heading="Detail">
            {trackerKeymap
              .filter(
                (entry) =>
                  entry.scope === "detail" &&
                  entry.group !== "Pull request" &&
                  hasTrackerAction(store, entry.id),
              )
              .map((entry) => (
                <Command.Item
                  key={entry.id}
                  onSelect={() =>
                    run(() => {
                      runTrackerAction(store, entry.id);
                    })
                  }
                >
                  {entry.label} <kbd>{formatKeys(entry.id)}</kbd>
                </Command.Item>
              ))}
          </Command.Group>

          <Command.Group heading="Issue">
            {current ? (
              <>
                <Command.Item onSelect={() => run(() => store.open(current))}>
                  Open {current} <kbd>{formatKeys("open")}</kbd>
                </Command.Item>
                <Command.Item
                  onSelect={() =>
                    run(() => {
                      store.open(current);
                      store.setTab("overview");
                    })
                  }
                >
                  Review changes and findings
                </Command.Item>
                <Command.Item
                  onSelect={() => run(() => runTrackerCommand(store, "stage"))}
                >
                  Change stage… <kbd>{formatKeys("stage")}</kbd>
                </Command.Item>
              </>
            ) : null}
          </Command.Group>

          <Command.Group heading="Create">
            <Command.Item
              onSelect={() => run(() => runTrackerCommand(store, "create"))}
            >
              Create… <kbd>{formatKeys("create")}</kbd>
            </Command.Item>
            {CREATABLES.map((entry) => (
              <Command.Item
                key={entry.id}
                onSelect={() => run(() => store.setCreate(entry.id))}
              >
                Create {entry.label.toLowerCase()}…
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Window">
            <ChimeMuteCommand close={close} />
            <Command.Item
              onSelect={() =>
                run(() => window.dispatchEvent(new Event("loom:open-main")))
              }
            >
              Open Main
            </Command.Item>
            <Command.Item
              onSelect={() =>
                run(() => void window.loomHost.setMode("workbench"))
              }
            >
              Switch to Workbench
            </Command.Item>
            <Command.Item
              onSelect={() =>
                run(() => void window.loomHost.openWindow("tracker"))
              }
            >
              New Tracker
            </Command.Item>
            <Command.Item onSelect={() => run(() => store.toggleTheme())}>
              Toggle theme
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Issue list">
            {canNavigateSections &&
              trackerKeymap
                .filter((entry) => entry.scope === "issue-list")
                .map((entry) => (
                  <Command.Item
                    key={entry.id}
                    onSelect={() =>
                      run(() => runTrackerCommand(store, entry.id))
                    }
                  >
                    {entry.label} <kbd>{formatKeys(entry.id)}</kbd>
                  </Command.Item>
                ))}
          </Command.Group>

          <Command.Group heading="Issues">
            {paletteIssueRows(rows, repos, value).map((row) => (
              <Command.Item
                key={row.task.id}
                value={paletteIssueValue(row, repos)}
                onSelect={() => run(() => store.open(row.task.id))}
              >
                <span className="mono faint">
                  {issueKeyFor(row.task, repos)}
                </span>
                <span>{displayName(row.task)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </Scrim>
  );
}

export function CreatePalette() {
  const store = useStoreApi();
  const open = useStore((s) => s.ui.createPalette);
  if (!open) return null;
  return (
    <Scrim onClose={() => store.setCreatePalette(false)}>
      <Command label="Create palette" loop>
        <Command.Input autoFocus placeholder="What would you like to create?" />
        <Command.List>
          <Command.Empty>Nothing matches.</Command.Empty>
          {CREATABLES.map((entry) => (
            <Command.Item
              key={entry.id}
              className="creatable"
              value={`${entry.label} ${entry.description}`}
              onSelect={() => store.setCreate(entry.id)}
            >
              <span>{entry.label}</span>
              <span className="faint">{entry.description}</span>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </Scrim>
  );
}

export function StagePicker() {
  const store = useStoreApi();
  const open = useStore((s) => s.ui.stagePicker);
  const target = useStore(paletteIssueTarget);
  if (!open) return null;
  const close = () => store.setStagePicker(false);

  return (
    <Scrim onClose={close}>
      <Command label="Change stage" loop>
        <Command.Input
          autoFocus
          placeholder={target ? `Move ${target} to…` : "No issue selected"}
        />
        <Command.List>
          <Command.Empty>No such stage.</Command.Empty>
          {STAGES.filter(
            (stage) => stage === "backlog" || stage === "todo",
          ).map((stage) => (
            <Command.Item
              key={stage}
              disabled={!target}
              onSelect={() => {
                close();
                if (target) {
                  store.moveTask(target, stage);
                }
              }}
            >
              {stageLabel(stage)}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </Scrim>
  );
}

function Scrim({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Capture focus before the palette input's autofocus, and restore before a dialog mounts.
  const [previous] = useState(() => document.activeElement);
  useLayoutEffect(() => {
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [previous]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop dismisses; `esc` does the same
    <div
      className="scrim"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette">{children}</div>
    </div>
  );
}
