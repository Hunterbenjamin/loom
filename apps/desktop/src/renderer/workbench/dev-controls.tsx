import { Command } from "cmdk";
import { useEffect, useState } from "react";
import type { DevControlCommand } from "../../shared/ipc.js";
import type { RowAction } from "./row-menu.js";

export function useDevControlAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    void window.loomHost.devControlAvailable?.().then(
      (value) => {
        if (!disposed) setAvailable(value);
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, []);
  return available;
}

function run(command: DevControlCommand) {
  void window.loomHost.devControl(command).catch((error: unknown) => {
    window.alert(String(error));
  });
}

export function devControlActions(
  available: boolean,
  session: string | null | undefined,
): RowAction[] {
  if (!available) return [];
  const command =
    session === "loom-coordinator"
      ? "restart-coordinator"
      : session === "loom-desktop"
        ? "restart-app"
        : null;
  if (!command) return [];
  return [
    {
      label: command === "restart-app" ? "Restart app" : "Restart coordinator",
      run: () => run(command),
    },
    { label: "Sync instance", run: () => run("sync") },
  ];
}

export function DevControlCommands({ close }: { close: () => void }) {
  const available = useDevControlAvailable();
  if (!available) return null;
  return (
    <>
      {(
        [
          ["sync", "Instance: sync"],
          ["restart-coordinator", "Instance: restart coordinator"],
          ["restart-app", "Instance: restart app"],
        ] as const
      ).map(([command, label]) => (
        <Command.Item
          key={command}
          onSelect={() => {
            close();
            run(command);
          }}
        >
          {label}
        </Command.Item>
      ))}
    </>
  );
}
