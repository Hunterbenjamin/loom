import { describe, expect, it } from "vitest";
import {
  base,
  command,
  finding,
  fixed,
  fixture,
  head,
  mcp,
  now,
  plan,
  submit,
} from "../test/fixtures.js";
import type { Run, RunObservation } from "./index.js";
import { reconcile } from "./index.js";

describe("input consumption and MCP dispositions", () => {
  it("consumes each ID once even when duplicated in the same batch or replayed", () => {
    const f = fixture();
    const input = mcp({
      tool: "report_progress",
      input: {
        summary: "Working",
        stepIndex: 0,
        decisions: ["Decision"],
        testResults: [],
      },
    });
    f.observations.inputs = [input, input];
    const r = fixed(f.state, f.observations);
    expect(r.inputs).toHaveLength(1);
    expect(r.next.artifactContents.decisions).toEqual(["Decision"]);
    expect(reconcile(r.next, f.observations).inputs).toEqual([]);
  });
  it("rejected IDs are consumed too, without applying their payload", () => {
    const f = fixture();
    f.observations.inputs = [
      mcp({ tool: "submit_plan", input: { plan } }, "implementer"),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.inputs[0]).toMatchObject({
      accepted: false,
      error: { code: "wrong_stage" },
    });
    expect(r.next.artifacts).toEqual([]);
    expect(reconcile(r.next, f.observations).inputs).toEqual([]);
  });
  for (const [name, change, code] of [
    [
      "unknown run",
      (f: ReturnType<typeof fixture>) => {
        f.state.runs = [];
      },
      "unknown_run",
    ],
    [
      "ended run",
      (f: ReturnType<typeof fixture>) => {
        const run = f.state.runs[1];
        if (run) run.endedAt = now;
      },
      "stale_run",
    ],
    [
      "external run",
      (f: ReturnType<typeof fixture>) => {
        const run = f.state.runs[1];
        if (run) run.origin = "external";
      },
      "unknown_run",
    ],
    [
      "canceled task",
      (f: ReturnType<typeof fixture>) => {
        f.state.task.stage = "canceled";
      },
      "stale_run",
    ],
  ] as const)
    it(name, () => {
      const f = fixture();
      change(f);
      f.observations.inputs = [
        mcp({
          tool: "report_progress",
          input: {
            summary: "",
            stepIndex: null,
            decisions: [],
            testResults: [],
          },
        }),
      ];
      expect(fixed(f.state, f.observations).inputs[0]).toMatchObject({
        accepted: false,
        error: { code },
      });
    });
  it("preserves command arrival order", () => {
    const f = fixture("backlog");
    f.observations.capacity.caps.total = 0;
    f.observations.inputs = [
      command({ type: "move", to: "todo" }, "a"),
      command({ type: "move", to: "backlog" }, "b"),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.transitions.map((t) => [t.from, t.to])).toEqual([
      ["backlog", "todo"],
      ["todo", "backlog"],
    ]);
    expect(r.transitions.every((t) => t.taskVersion === 2)).toBe(true);
  });
  for (const index of [-1, 1, 0.5])
    it(`progress rejects invalid step ${index}`, () => {
      const f = fixture();
      f.observations.inputs = [
        mcp({
          tool: "report_progress",
          input: {
            summary: "",
            stepIndex: index,
            decisions: [],
            testResults: [],
          },
        }),
      ];
      expect(fixed(f.state, f.observations).inputs[0]).toMatchObject({
        accepted: false,
        error: { code: "guard_failed" },
      });
    });
  it("current submissions remain valid under flags", () => {
    const f = fixture("planning");
    f.state.task.requirePlanApproval = true;
    f.state.task.failed = {
      reason: "action_failed",
      detail: "Unrelated action",
      since: now,
      runId: null,
    };
    f.observations.inputs = [
      mcp({ tool: "submit_plan", input: { plan } }, "planner"),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.inputs[0]?.accepted).toBe(true);
    expect(r.next.task.stage).toBe("plan_approval");
    expect(r.actions.some((a) => a.kind === "start_run")).toBe(false);
  });
  it("dirty-tree errors name the offending paths and ignore ignored output", () => {
    const f = fixture();
    f.observations.inputs = [mcp(submit())];
    if (f.observations.git?.ok) {
      f.observations.git.value.dirty = true;
      f.observations.git.value.dirtyPaths = ["src/a.ts", "new.ts"];
    }
    const r = fixed(f.state, f.observations);
    const d = r.inputs[0];
    if (!d || d.accepted) throw Error("Expected rejection");
    expect(d.error.details.join("\n")).toContain("src/a.ts, new.ts");
  });
  for (const resolution of ["fixed", "disputed"] as const)
    it(`resolve finding ${resolution}`, () => {
      const f = fixture();
      f.state.findings = [finding()];
      f.observations.inputs = [
        mcp({
          tool: "resolve_finding",
          input: {
            findingId: finding().id,
            resolution,
            note: "Explanation",
            commitSha: resolution === "fixed" ? head : null,
          },
        }),
      ];
      expect(fixed(f.state, f.observations).next.findings[0]?.status).toBe(
        resolution === "fixed" ? "addressed" : "disputed",
      );
    });
  for (const problem of [
    "missing",
    "not-open",
    "no-commit",
    "unreachable",
    "git-unknown",
  ])
    it(`resolve finding rejects ${problem}`, () => {
      const f = fixture();
      f.state.findings =
        problem === "missing"
          ? []
          : [
              finding("f1", {
                status: problem === "not-open" ? "resolved" : "open",
              }),
            ];
      f.observations.inputs = [
        mcp({
          tool: "resolve_finding",
          input: {
            findingId: finding().id,
            resolution: "fixed",
            note: "Fixed",
            commitSha:
              problem === "no-commit"
                ? null
                : problem === "unreachable"
                  ? base
                  : head,
          },
        }),
      ];
      if (problem === "git-unknown")
        f.observations.git = { ok: false, reason: "Unavailable", at: now };
      expect(fixed(f.state, f.observations).inputs[0]).toMatchObject({
        accepted: false,
        error: { code: "guard_failed" },
      });
    });
  it("requires current Codex request generation", () => {
    const f = fixture();
    const r = f.state.runs[1] as Run;
    const o = f.observations.runs[1] as RunObservation;
    if (o.provider.ok && o.provider.value?.provider === "codex") {
      o.provider.value.generation = 2;
      o.provider.value.pendingRequests = [
        {
          requestId: "request",
          kind: "command_approval",
          isBlocking: true,
          summary: "Run tests",
          receivedAt: now,
        },
      ];
    }
    f.observations.inputs = [
      command({
        type: "answer_provider_request",
        runId: r.id,
        requestId: "request",
        generation: 1,
        decision: "accept",
        answers: null,
      }),
    ];
    expect(fixed(f.state, f.observations).inputs[0]).toMatchObject({
      accepted: false,
      error: { code: "guard_failed" },
    });
    f.observations.inputs = [
      command({
        type: "answer_provider_request",
        runId: r.id,
        requestId: "request",
        generation: 2,
        decision: "accept",
        answers: null,
      }),
    ];
    expect(
      fixed(f.state, f.observations).actions.find(
        (a) => a.kind === "answer_provider_request",
      ),
    ).toMatchObject({ generation: 2, requestId: "request" });
  });
  it("reconcile never mutates its input objects", () => {
    const f = fixture("planning");
    f.observations.inputs = [
      mcp({ tool: "submit_plan", input: { plan } }, "planner"),
    ];
    const before = JSON.stringify(f);
    reconcile(f.state, f.observations);
    expect(JSON.stringify(f)).toBe(before);
  });
});
