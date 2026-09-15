// @vitest-environment happy-dom
import type { AckOutcome, BriefRun, BriefState, Command } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { BriefsView } from "./briefs.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const completed: BriefRun = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  trigger: "scheduled",
  scheduledDate: "2026-09-15",
  status: "completed",
  startedAt: "2026-09-14T23:00:00.000Z",
  finishedAt: "2026-09-14T23:05:00.000Z",
  model: "fake",
  error: null,
  content: {
    headline: "A useful workflow experiment",
    summary: "Try measuring review time.",
    items: [
      {
        title: "Parallel development",
        category: "workflow",
        publishedOn: "2026-09-15",
        whatChanged: "A fixture example.",
        implication: "Test independent tasks.",
        evidence: "practitioner_experience",
        caveat: "Not an independent benchmark.",
        nextStep: "Measure total time.",
        sources: [
          { title: "Original research", url: "https://example.invalid/paper" },
        ],
      },
    ],
    workflowExperiment: "Measure before scaling.",
    opportunity: null,
    coverage: "Fixture only.",
  },
};
async function mount(runs: BriefRun[] = []) {
  const store = createStore(buildSnapshot());
  const state: BriefState = {
    schedule: { enabled: true, hour: 7, timeZone: "Asia/Makassar" },
    runs,
  };
  const send = vi.fn(async (command: Command): Promise<AckOutcome> => {
    if (command.kind === "set_brief_schedule")
      state.schedule.enabled = command.enabled;
    if (command.kind === "run_brief") {
      const run: BriefRun = {
        ...completed,
        id: command.id,
        status: "running",
        content: null,
        finishedAt: null,
      };
      state.runs = [run, ...state.runs];
      return { ok: true, result: { kind: "brief", run } };
    }
    if (command.kind === "get_brief")
      return {
        ok: true,
        result: {
          kind: "brief",
          run: runs.find((run) => run.id === command.id) ?? {
            ...completed,
            id: command.id,
            status: "running",
            content: null,
          },
        },
      };
    return {
      ok: true,
      result: { kind: "briefs", state: structuredClone(state) },
    };
  });
  store.setSender(send);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: createElement with required typed children.
        children: createElement(BriefsView),
      }),
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, send };
}

test("manual run starts from the empty state and disables overlapping launches", async () => {
  const { host, send } = await mount();
  expect(host.textContent).toContain("7:00 a.m.");
  const button = host.querySelector("button");
  if (!button) throw new Error("Missing Run now");
  await act(async () => button.click());
  expect(send).toHaveBeenCalledWith({
    kind: "run_brief",
    id: expect.any(String),
  });
  expect(button.disabled).toBe(true);
  expect(host.textContent).toContain("Researching live sources");
});
test("renders source links, implications and saved schedule control", async () => {
  const { host, send } = await mount([completed]);
  expect(host.textContent).toContain("Why it matters to you");
  expect(host.textContent).toContain("Practitioner experience");
  expect(host.querySelector("a")?.href).toBe("https://example.invalid/paper");
  const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!toggle) throw new Error("Missing schedule control");
  await act(async () => toggle.click());
  expect(send).toHaveBeenCalledWith({
    kind: "set_brief_schedule",
    enabled: false,
  });
  expect(toggle.checked).toBe(false);
});
test("failed research remains readable and can be run again", async () => {
  const { host } = await mount([
    {
      ...completed,
      status: "failed",
      error: "Search unavailable",
      content: null,
    },
  ]);
  expect(host.textContent).toContain("Search unavailable");
  expect(host.querySelector("button")?.disabled).toBe(false);
});
