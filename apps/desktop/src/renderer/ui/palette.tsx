import { displayName } from "@loom/core";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { STAGES } from "../fixtures/index.js";
import { useStore, useStoreApi } from "../store/react.js";
import { cursorRows, issueKeyFor, selectedRows } from "../store/selectors.js";
import { VIEWS } from "../store/store.js";
import { ChimeMuteCommand } from "../workbench/chime.js";
import { stageLabel } from "./format.js";
import { PullRequestPaletteCommands } from "./pull-request-commands.js";

export function Palette() {
  const store = useStoreApi();
  const open = useStore((s) => s.ui.palette);
  const rows = useStore(selectedRows);
  const visibleRows = useStore(cursorRows);
  const cursor = useStore((s) => s.ui.cursor);
  const openTask = useStore((s) => s.ui.openTask);
  const openPr = useStore((s) => s.ui.openPr);
  const view = useStore((s) => s.ui.view);
  const pane = useStore((s) => s.ui.pane);
  const repos = useStore((s) => s.snapshot.repos);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  if (!open) return null;
  const current = openPr
    ? null
    : (openTask ??
      (view === "pull-requests"
        ? null
        : (visibleRows[cursor]?.task.id ?? null)));
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
                onSelect={() => run(() => store.setView(view.id))}
              >
                {view.label}
              </Command.Item>
            ))}
            <Command.Item
              onSelect={() =>
                run(() => store.setPane(pane === "list" ? "board" : "list"))
              }
            >
              Switch to {pane === "list" ? "board" : "list"}
            </Command.Item>
          </Command.Group>

          <PullRequestPaletteCommands close={close} />

          <Command.Group heading="Issue">
            {current ? (
              <>
                <Command.Item onSelect={() => run(() => store.open(current))}>
                  Open {current}
                </Command.Item>
                <Command.Item
                  onSelect={() =>
                    run(() => {
                      store.open(current);
                      store.setTab("review");
                    })
                  }
                >
                  Review changes and findings
                </Command.Item>
                <Command.Item
                  onSelect={() => run(() => store.setStagePicker(true))}
                >
                  Change stage…
                </Command.Item>
              </>
            ) : null}
            <Command.Item
              onSelect={() => run(() => store.setCreateIssue(true))}
            >
              Create issue…
            </Command.Item>
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
            <Command.Item onSelect={() => run(() => store.setSearching(true))}>
              Search issues
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Issues">
            {rows.slice(0, 60).map((row) => (
              <Command.Item
                key={row.task.id}
                value={`${issueKeyFor(row.task, repos)} ${row.task.number} ${row.task.name ?? ""} ${row.task.title}`}
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

export function StagePicker() {
  const store = useStoreApi();
  const open = useStore((s) => s.ui.stagePicker);
  const rows = useStore(cursorRows);
  const cursor = useStore((s) => s.ui.cursor);
  const openTask = useStore((s) => s.ui.openTask);
  if (!open) return null;
  const target = openTask ?? rows[cursor]?.task.id ?? null;
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
          {STAGES.map((stage) => (
            <Command.Item
              key={stage}
              onSelect={() => {
                close();
                if (target) {
                  store.moveTask(target, stage);
                  store.toast(`${target} → ${stageLabel(stage)}`);
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
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop dismisses; `esc` does the same
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette">{children}</div>
    </div>
  );
}
