// @vitest-environment happy-dom
import type { Run } from "@loom/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { runId } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { ProviderLabel, RunDot } from "./bits.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const fn of cleanups.splice(0)) fn();
  });
});

describe("RunDot", () => {
  function renderDot(run: Run | null): HTMLElement {
    const container = document.createElement("div");
    document.body.append(container);

    const root = createRoot(container);
    act(() => {
      root.render(createElement(RunDot, { run }));
    });

    cleanups.push(() => {
      root.unmount();
      container.remove();
    });

    const span = container.querySelector("span");
    if (!span) throw new Error("RunDot did not render a span");
    return span;
  }

  test("renders faint dot when no run", () => {
    const dot = renderDot(null);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("faint");
  });

  test("renders animated dot for working status", () => {
    const fixture = buildSnapshot();
    const run = fixture.runs.find((r) => r.status === "working");
    if (!run) throw new Error("No working run in fixture");

    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-animated");
  });

  test("renders animated dot for starting status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, status: "starting" as const };
    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-animated");
  });

  test("renders attention dot for blocked status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, status: "blocked" as const, blockedOn: "permission" };
    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-attention");
  });

  test("renders stage dot for idle status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, status: "idle" as const };
    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-stage");
  });

  test("renders stage dot for ended status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, status: "ended" as const, endReason: "submitted" };
    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-stage");
  });

  test("renders failed dot for failed status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, status: "failed" as const };
    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-failed");
  });

  test("renders unknown dot for unknown status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, status: "unknown" as const };
    const dot = renderDot(run);
    expect(dot.className).toContain("dot");
    expect(dot.className).toContain("dot-unknown");
  });

  test("includes title with role, provider, and status", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs.find((r) => r.status === "working");
    if (!run) {
      const baseRun = fixture.runs[0];
      if (!baseRun) throw new Error("No run in fixture");
      run = { ...baseRun, status: "working" as const } as Run;
    }

    const dot = renderDot(run);
    expect(dot.title).toContain(run.role);
    expect(dot.title).toContain(run.provider);
    expect(dot.title).toContain("Working");
  });
});

describe("ProviderLabel", () => {
  function renderLabel(run: Run | null, runs?: Run[]): HTMLElement {
    const container = document.createElement("div");
    document.body.append(container);

    const root = createRoot(container);
    act(() => {
      root.render(createElement(ProviderLabel, { run, runs }));
    });

    cleanups.push(() => {
      root.unmount();
      container.remove();
    });

    return container.firstElementChild as HTMLElement;
  }

  test("renders em-dash when no run and not blank", () => {
    const elem = renderLabel(null);
    expect(elem.textContent).toBe("—");
    expect(elem.className).toContain("faint");
  });

  test("renders nothing when no run and blank=true", () => {
    const container = document.createElement("div");
    document.body.append(container);

    const root = createRoot(container);
    act(() => {
      root.render(createElement(ProviderLabel, { run: null, blank: true }));
    });

    cleanups.push(() => {
      root.unmount();
      container.remove();
    });

    expect(container.innerHTML).toBe("");
  });

  test("renders the role and short model name", () => {
    const fixture = buildSnapshot();
    const run = {
      ...fixture.runs[0],
      role: "planner",
      provider: "claude",
      model: "claude-haiku-4-5-20251001",
    } as Run;
    const elem = renderLabel(run, [run]);
    expect(elem.textContent).toBe("planner haiku");
    expect(elem.title).toContain(run.model);
  });

  test("keeps provider details and extra runs in the tooltip, not the label", () => {
    const fixture = buildSnapshot();
    const run = {
      ...fixture.runs[0],
      role: "implementer",
      provider: "codex",
      model: "gpt-6-astra",
    } as Run;
    const runs = [
      run,
      { ...run, id: runId("run-2") },
      { ...run, id: runId("run-3") },
    ];
    const elem = renderLabel(run, runs);
    expect(elem.textContent).toBe("implementer astra");
    expect(elem.title).toContain("gpt-6-astra");
    expect(elem.title).toContain("3 runs");
  });

  test("handles empty model gracefully", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    run = { ...run, model: "" } as Run;
    const elem = renderLabel(run, [run]);
    const text = elem.textContent || "";
    expect(text).toContain("—");
  });

  test("shows most recent run details when multiple runs", () => {
    const fixture = buildSnapshot();
    const run1 = { ...fixture.runs[0], model: "old-model" } as Run;
    const run2 = {
      ...fixture.runs[0],
      id: runId("run-2"),
      model: "new-model",
    } as Run;
    const run3 = {
      ...fixture.runs[0],
      id: runId("run-3"),
      model: "newer-model",
    } as Run;

    const elem = renderLabel(run2, [run1, run2, run3]);
    const text = elem.textContent || "";
    expect(text).toContain("new-model");
    expect(text).not.toContain("+2");
    expect(elem.title).toContain("3 runs");
  });

  test("handles external runs with empty model", () => {
    const fixture = buildSnapshot();
    let run = fixture.runs.find((r) => r.origin === "external");
    if (!run) run = { ...fixture.runs[0], origin: "external" as const } as Run;

    run = { ...run, model: "" } as Run;
    const elem = renderLabel(run, [run]);
    const text = elem.textContent || "";
    expect(text).toContain("—");
  });

  test("includes title for multiple runs", () => {
    const fixture = buildSnapshot();
    const run = fixture.runs[0];
    if (!run) throw new Error("No run in fixture");

    const runs = [run, { ...run, id: runId("run-2") }];
    const elem = renderLabel(run, runs);
    expect(elem.title).toContain("2 runs");
  });
});
