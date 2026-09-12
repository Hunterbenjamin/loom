import type { Run } from "@loom/core";
import { expect, test } from "vitest";
import { pane as paneFixture } from "../../../../../packages/protocol/src/pane-fixture.js";
import { buildSnapshot } from "../fixtures/index.js";
import { agentState, terminalAgents } from "./agents.js";

const snapshot = buildSnapshot();
const run = { ...snapshot.runs[0], lastTurn: null } as Run;

test("distinguishes waiting, rate limits, idle, unavailable, failure and actual completion", () => {
  const state = (patch: Partial<Run>) => agentState({ ...run, ...patch });
  expect(state({ status: "working" }).label).toBe("Working");
  expect(state({ status: "blocked", blockedOn: "input" }).label).toBe(
    "Awaiting response",
  );
  expect(state({ status: "blocked", blockedOn: "permission" }).label).toBe(
    "Awaiting permission",
  );
  expect(state({ status: "blocked", blockedOn: "rate_limit" }).label).toBe(
    "Rate limited",
  );
  expect(state({ status: "idle" }).label).toBe("Idle");
  expect(state({ status: "unknown" }).label).toBe("Status unavailable");
  expect(state({ status: "ended", endReason: "submitted" }).label).toBe(
    "Finished",
  );
  expect(state({ status: "ended", endReason: "crashed" }).label).toBe("Failed");
  expect(state({ status: "ended", endReason: "canceled" }).label).toBe(
    "Canceled",
  );
});

test("only lists running agent terminals and keeps the exact pane as the click target", () => {
  const pane = {
    ...paneFixture,
    runId: run.id,
    dead: false,
    unavailable: false,
  };
  const agent = { ...run, status: "working" as const, pane };
  const rows = terminalAgents([pane], [agent], []);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.pane).toBe(pane);
  expect(terminalAgents([], [agent], [])).toEqual([]);
  expect(
    terminalAgents([pane], [{ ...agent, pane: null, mode: "headless" }], []),
  ).toEqual([]);
  expect(
    terminalAgents(
      [pane],
      [{ ...agent, status: "ended", endReason: "submitted" }],
      [],
    ),
  ).toEqual([]);
  expect(terminalAgents([{ ...pane, dead: true }], [agent], [])).toEqual([]);
  expect(terminalAgents([{ ...pane, unavailable: true }], [agent], [])).toEqual(
    [],
  );
  expect(
    terminalAgents([{ ...pane, hostGeneration: "different" }], [agent], []),
  ).toEqual([]);
  expect(terminalAgents([{ ...pane, runId: null }], [agent], [])).toEqual([]);
});

test("live terminal icons reflect questions and completed turns without treating quiet output as completion", () => {
  const question = {
    ...snapshot.questions[0],
    runId: run.id,
    answeredAt: null,
  } as (typeof snapshot.questions)[number];
  expect(agentState({ ...run, status: "idle" }, [question]).label).toBe(
    "Awaiting response",
  );
  expect(
    agentState({
      ...run,
      status: "idle",
      lastTurn: { id: "turn-1", outcome: "completed", error: null },
    }).label,
  ).toBe("Finished turn");
  expect(agentState({ ...run, status: "idle", lastTurn: null }).label).toBe(
    "Idle",
  );
});
