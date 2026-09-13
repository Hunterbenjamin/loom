import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { STAGES } from "../fixtures/index.js";
import { useStore, useStoreApi } from "../store/react.js";
import { selectedRows } from "../store/selectors.js";
import { VIEWS } from "../store/store.js";
import { stageLabel } from "./format.js";

export function Palette() {
  const store = useStoreApi();
  const open = useStore((s) => s.ui.palette);
  const rows = useStore(selectedRows);
  const cursor = useStore((s) => s.ui.cursor);
  const openTask = useStore((s) => s.ui.openTask);
  const pane = useStore((s) => s.ui.pane);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  if (!open) return null;
  const current = openTask ?? rows[cursor]?.task.id ?? null;
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
          placeholder="Type a command, or a task to open…"
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

          <Command.Group heading="Task">
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
              onSelect={() =>
                run(() => store.createTask(value || "New task", "all"))
              }
            >
              Create task {value ? `"${value}"` : ""}
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Window">
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
              Search tasks
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Tasks">
            {rows.slice(0, 60).map((row) => (
              <Command.Item
                key={row.task.id}
                value={`${row.task.id} ${row.task.title}`}
                onSelect={() => run(() => store.open(row.task.id))}
              >
                <span className="mono faint">{row.task.id}</span>
                <span>{row.task.title}</span>
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
  const rows = useStore(selectedRows);
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
          placeholder={target ? `Move ${target} to…` : "No task selected"}
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
