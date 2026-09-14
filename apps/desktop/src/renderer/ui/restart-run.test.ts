// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Detail } from "./detail.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("Agents restarts the current run through the validated command without editing the snapshot", async () => {
  const snapshot = buildSnapshot(10);
  const task = snapshot.tasks.find((t) =>
    snapshot.runs.some(
      (r) =>
        r.taskId === t.id && r.role === "implementer" && r.origin === "loom",
    ),
  );
  if (!task) throw new Error("Missing task fixture");
  task.stage = "in_progress";
  const run = snapshot.runs
    .filter(
      (r) =>
        r.taskId === task.id && r.role === "implementer" && r.origin === "loom",
    )
    .at(-1);
  if (!run) throw new Error("Missing run fixture");
  run.endReason = null;
  const store = createStore(snapshot, true, "dev");
  store.setTab("overview");
  store.setConnection("connected");
  const send = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: "guard_failed" as const,
      message: "Refresh the current run",
      details: [],
    },
  }));
  store.setSender(send);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
          children: createElement(Detail, { task }),
        }),
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Restart with current agent settings",
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(send).toHaveBeenCalledExactlyOnceWith({
      kind: "human",
      taskId: task.id,
      command: { type: "restart_run", runId: run.id },
    });
    expect(store.getState().snapshot).toBe(snapshot);
    expect(host.textContent).toContain("Refresh the current run");
    await act(async () => store.setConnection("disconnected"));
    expect(button?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
