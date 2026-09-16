// @vitest-environment happy-dom
import type { AckOutcome, BriefRun, BriefState, Command } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
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
  model: "claude-sonnet-4-6",
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
  const summary = ({ content, ...run }: BriefRun) => ({
    ...run,
    headline: content?.headline ?? null,
  });
  const state: BriefState = {
    schedule: { enabled: true, hour: 7, timeZone: "Asia/Makassar" },
    runs: runs.map(summary),
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
      state.runs = [summary(run), ...state.runs];
      return { ok: true, result: { kind: "brief", run } };
    }
    if (command.kind === "get_brief") {
      const run = runs.find((item) => item.id === command.id);
      if (!run) throw new Error(`Unexpected brief ${command.id}`);
      return { ok: true, result: { kind: "brief", run } };
    }
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
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const row = (id: string) => {
    const found = host.querySelector<HTMLElement>(`[data-brief="${id}"]`);
    if (!found) throw new Error(`Missing brief row ${id}`);
    return found;
  };
  return { host, send, store, button, row };
}

test("manual run starts from the empty state, lists the running brief and disables overlapping launches", async () => {
  const { host, send, button } = await mount();
  expect(host.textContent).toContain("7:00 a.m.");
  await act(async () => button("Run now").click());
  expect(send).toHaveBeenCalledWith({
    kind: "run_brief",
    id: expect.any(String),
  });
  expect(button("Researching…").disabled).toBe(true);
  expect(
    host.querySelector('[data-testid="briefs-list"]')?.textContent,
  ).toContain("Researching live sources");
  expect(host.querySelector('[data-testid="brief-detail"]')).toBeNull();
});

test("the history lists each brief by headline, and a click opens it in the Reviews layout", async () => {
  const { host, send, store, button, row } = await mount([completed]);
  expect(row(completed.id).textContent).toContain(
    "A useful workflow experiment",
  );
  expect(host.querySelector('[data-testid="brief-detail"]')).toBeNull();

  await act(async () => row(completed.id).click());
  const detail = host.querySelector('[data-testid="brief-detail"]');
  expect(store.getState().ui.openBrief).toBe(completed.id);
  expect(detail?.querySelector(".pr-story h1")?.textContent).toBe(
    "A useful workflow experiment",
  );
  expect(detail?.querySelector(".pr-rail")?.textContent).toContain(
    "Parallel development",
  );
  const byline = detail?.querySelector(".pr-byline");
  expect(byline?.textContent).toContain("Loom brief agent · sonnet");
  expect(byline?.textContent).toContain("Daily edition");
  expect(byline?.querySelector(".pr-avatar svg")).not.toBeNull();
  expect(byline?.querySelector('[title="claude-sonnet-4-6"]')).not.toBeNull();
  expect(detail?.textContent).toContain("Why it matters to you");
  expect(detail?.textContent).toContain("Practitioner experience");
  expect(detail?.querySelector("a")?.href).toBe(
    "https://example.invalid/paper",
  );

  await act(async () => button("Daily brief").click());
  expect(host.querySelector('[data-testid="brief-detail"]')).toBeNull();

  const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!toggle) throw new Error("Missing schedule control");
  await act(async () => toggle.click());
  expect(send).toHaveBeenCalledWith({
    kind: "set_brief_schedule",
    enabled: false,
  });
  expect(toggle.checked).toBe(false);
});

test("failed research stays readable and can be run again", async () => {
  const failed: BriefRun = {
    ...completed,
    status: "failed",
    error: "Search unavailable",
    content: null,
  };
  const { host, button, row } = await mount([failed]);
  expect(row(failed.id).textContent).toContain("Research failed");
  await act(async () => row(failed.id).click());
  expect(
    host.querySelector('[data-testid="brief-detail"]')?.textContent,
  ).toContain("Search unavailable");
  expect(button("Run now").disabled).toBe(false);
});

test("brief keyboard endpoints open the visible brief", async () => {
  const { createShortcutHandler } = await import("./keys.js");
  const second = {
    ...completed,
    id: "00000000-0000-4000-8000-000000000003",
    content: null,
    status: "failed" as const,
  };
  const h = await mount([completed, second]);
  act(() => h.store.setView("briefs"));
  const handler = createShortcutHandler(h.store);
  const press = (key: string) =>
    act(() => handler(new KeyboardEvent("keydown", { key })));
  press("G");
  expect(h.store.getState().ui.cursor).toBe(1);
  press("g");
  press("g");
  expect(h.store.getState().ui.cursor).toBe(0);
  expect(h.host.querySelectorAll("[data-brief]")).toHaveLength(2);
  press("j");
  await act(async () => press("Enter"));
  expect(h.store.getState().ui.openBrief).toBe(second.id);
  expect(h.store.getState().ui.openTask).toBeNull();
});

test("a brief with no recorded model keeps an honest agent byline", async () => {
  const { host, row } = await mount([
    { ...completed, model: "", trigger: "manual" },
  ]);
  await act(async () => row(completed.id).click());
  const byline = host.querySelector(".pr-byline");
  expect(byline?.textContent).toContain(
    "Loom brief agent · Model not recorded",
  );
  expect(byline?.textContent).toContain("Manual run");
  expect(byline?.querySelector(".pr-avatar svg")).not.toBeNull();
});
