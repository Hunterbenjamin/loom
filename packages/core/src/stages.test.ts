import { describe, expect, it } from "vitest";
import {
  actionInput,
  base,
  command,
  finding,
  fixed,
  fixture,
  head,
  mcp,
  now,
  plan,
  reviewCall,
  submit,
} from "../test/fixtures.js";
import type { Action, Input, Stage } from "./index.js";

type Setup = (f: ReturnType<typeof fixture>) => void;
function row(
  number: number,
  from: Stage,
  to: Stage,
  setup: Setup,
  expected: string[] = [],
) {
  it(`#${number}: ${from} → ${to}`, () => {
    const f = fixture(from);
    setup(f);
    const result = fixed(f.state, f.observations);
    expect(result.next.task.stage).toBe(to);
    expect(result.transitions.some((t) => t.from === from && t.to === to)).toBe(
      true,
    );
    expect(result.inputs.every((i) => i.accepted)).toBe(true);
    for (const kind of expected)
      expect(result.actions.some((a) => a.kind === kind)).toBe(true);
  });
}
const blockReview: Setup = ({ state }) => {
  state.task.blocked = {
    reason: "review_round_cap",
    since: now,
    detail: "Cap",
    until: null,
    questionId: null,
  };
  state.findings = [finding()];
};
const noCapacity: Setup = ({ observations }) => {
  observations.capacity.caps.total = 0;
};
const merged: Setup = ({ observations }) => {
  if (observations.github?.ok && observations.github.value)
    observations.github.value.state = "merged";
};

describe("all 23 transition rows", () => {
  row(1, "backlog", "todo", (f) => {
    noCapacity(f);
    f.observations.inputs = [command({ type: "move", to: "todo" })];
  });
  row(2, "todo", "backlog", (f) => {
    noCapacity(f);
    f.observations.inputs = [command({ type: "move", to: "backlog" })];
  });
  row(
    3,
    "todo",
    "planning",
    ({ state }) => {
      state.plan = null;
      state.runs = [];
      state.worktree = null;
      state.task.worktreePath = null;
      state.task.branch = null;
    },
    ["create_worktree"],
  );
  row(
    4,
    "todo",
    "in_progress",
    ({ state }) => {
      state.runs = [];
    },
    ["write_task_files", "start_run"],
  );
  row(
    5,
    "planning",
    "plan_approval",
    ({ state, observations }) => {
      state.task.requirePlanApproval = true;
      observations.inputs = [
        mcp({ tool: "submit_plan", input: { plan } }, "planner"),
      ];
    },
    ["notify"],
  );
  row(
    6,
    "planning",
    "in_progress",
    ({ state, observations }) => {
      state.runs = state.runs.filter((r) => r.role !== "implementer");
      observations.inputs = [
        mcp({ tool: "submit_plan", input: { plan } }, "planner"),
      ];
    },
    ["start_run"],
  );
  row(
    7,
    "plan_approval",
    "in_progress",
    ({ state, observations }) => {
      if (state.plan) state.plan.accepted = false;
      state.runs = state.runs.filter((r) => r.role !== "implementer");
      observations.inputs = [command({ type: "approve_plan", planVersion: 1 })];
    },
    ["start_run"],
  );
  row(
    8,
    "plan_approval",
    "planning",
    ({ state, observations }) => {
      const r = state.runs.find((r) => r.role === "planner");
      if (r) {
        r.endedAt = now;
        r.endReason = "submitted";
      }
      observations.inputs = [
        command({ type: "reject_plan", feedback: "More tests" }),
      ];
    },
    ["start_run"],
  );
  row(
    9,
    "in_progress",
    "in_review",
    ({ state, observations }) => {
      state.task.reviewRound = 0;
      state.runs = state.runs.filter((r) => r.role !== "reviewer");
      state.task.prNumber = null;
      observations.inputs = [mcp(submit())];
    },
    ["push_branch", "start_run"],
  );
  row(
    10,
    "in_review",
    "awaiting_approval",
    ({ observations }) => {
      observations.inputs = [mcp(reviewCall(), "reviewer")];
    },
    ["notify"],
  );
  row(
    11,
    "in_review",
    "in_progress",
    ({ observations }) => {
      observations.inputs = [mcp(reviewCall([finding()]), "reviewer")];
    },
    ["send_message"],
  );
  row(
    12,
    "in_review",
    "in_review",
    ({ state, observations }) => {
      state.task.reviewRoundCap = 1;
      observations.inputs = [mcp(reviewCall([finding()]), "reviewer")];
    },
    ["notify"],
  );
  row(
    13,
    "in_review",
    "in_progress",
    (f) => {
      blockReview(f);
      f.observations.inputs = [command({ type: "grant_review_round" })];
    },
    ["send_message"],
  );
  row(
    14,
    "in_review",
    "awaiting_approval",
    (f) => {
      blockReview(f);
      f.observations.inputs = [
        command({
          type: "waive_finding",
          findingId: finding().id,
          note: "Accept",
        }),
      ];
    },
    ["notify"],
  );
  row(
    15,
    "awaiting_approval",
    "merging",
    ({ observations }) => {
      observations.inputs = [command({ type: "approve", headSha: head })];
    },
    ["merge_pr"],
  );
  row(
    16,
    "merging",
    "in_review",
    ({ observations }) => {
      if (observations.github?.ok && observations.github.value) {
        observations.github.value.headSha = base;
        observations.github.value.autoMergeEnabled = true;
      }
    },
    ["disable_auto_merge", "map_findings", "start_run"],
  );
  row(
    17,
    "merging",
    "in_progress",
    ({ observations }) => {
      if (observations.github?.ok && observations.github.value) {
        observations.github.value.ci.conclusion = "failure";
        observations.github.value.ci.checks = [
          {
            id: "check1",
            name: "test",
            status: "completed",
            conclusion: "failure",
            url: null,
          },
        ];
        observations.github.value.autoMergeEnabled = true;
      }
    },
    ["disable_auto_merge", "send_message"],
  );
  row(
    18,
    "awaiting_approval",
    "in_progress",
    ({ observations }) => {
      observations.inputs = [
        command({ type: "request_changes", findings: [finding()] }),
      ];
    },
    ["send_message"],
  );
  row(
    19,
    "merging",
    "awaiting_approval",
    ({ state, observations }) => {
      const action = {
        kind: "merge_pr",
        key: "merge_pr:a",
        taskId: state.task.id,
        repoId: state.task.repoId,
        prNumber: 1,
        matchHeadSha: head,
        auto: false,
      } as Action;
      state.outbox = [
        {
          key: action.key,
          kind: action.kind,
          action,
          status: "running",
          attempts: 1,
          createdAt: now,
          finishedAt: null,
        },
      ];
      observations.inputs = [
        {
          ...actionInput(action, {}),
          result: {
            kind: "merge_pr",
            ok: false,
            error: { code: "precondition", message: "Not mergeable" },
          },
        } as Input,
      ];
    },
    ["notify"],
  );
  row(20, "backlog", "done", merged, ["notify"]);
  row(
    21,
    "in_progress",
    "canceled",
    ({ observations }) => {
      observations.inputs = [command({ type: "cancel", reason: "Stop" })];
    },
    [],
  );
  row(22, "canceled", "backlog", ({ observations }) => {
    observations.inputs = [command({ type: "reopen" })];
  });
  row(
    23,
    "planning",
    "backlog",
    ({ observations }) => {
      observations.inputs = [command({ type: "move", to: "backlog" })];
    },
    [],
  );
});

describe("guarded automatic merge policy", () => {
  it("creates a policy-attributed exact-head approval only after every merge guard passes", () => {
    const f = fixture("awaiting_approval");
    f.state.task.mergePolicy = "auto-all";
    const result = fixed(f.state, f.observations);
    expect(result.next.task.stage).toBe("merging");
    expect(result.next.approvals).toContainEqual(
      expect.objectContaining({
        kind: "merge",
        headSha: head,
        approvedBy: "policy",
        voidedAt: null,
      }),
    );
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: "merge_pr", matchHeadSha: head }),
    );
  });

  it("limits auto-small to small tasks and waits on pending or stale CI", () => {
    const normal = fixture("awaiting_approval");
    normal.state.task.mergePolicy = "auto-small";
    normal.state.task.size = "normal";
    expect(fixed(normal.state, normal.observations).next.task.stage).toBe(
      "awaiting_approval",
    );

    const pending = fixture("awaiting_approval");
    pending.state.task.mergePolicy = "auto-all";
    if (pending.observations.github?.ok && pending.observations.github.value)
      pending.observations.github.value.ci.conclusion = "pending";
    expect(fixed(pending.state, pending.observations).next.task.stage).toBe(
      "awaiting_approval",
    );

    const stale = fixture("awaiting_approval");
    stale.state.task.mergePolicy = "auto-all";
    if (stale.observations.github?.ok && stale.observations.github.value)
      stale.observations.github.value.ci.observedAt =
        "2026-09-11T00:00:00.000Z" as never;
    expect(fixed(stale.state, stale.observations).next.task.stage).toBe(
      "awaiting_approval",
    );
  });

  it("voids a policy approval and cancels its merge when the PR closes", () => {
    const f = fixture("awaiting_approval");
    f.state.task.mergePolicy = "auto-all";
    const approved = fixed(f.state, f.observations);
    expect(approved.next.task.stage).toBe("merging");
    if (f.observations.github?.ok && f.observations.github.value)
      f.observations.github.value.state = "closed";

    const closed = fixed(approved.next, f.observations);
    expect(closed.next.task.stage).toBe("awaiting_approval");
    expect(
      closed.next.approvals.find(
        (approval) => approval.kind === "merge" && !approval.voidedAt,
      ),
    ).toBeUndefined();
    expect(
      closed.next.outbox.find((row) => row.kind === "merge_pr")?.status,
    ).toBe("canceled");
  });
});

function reject(
  name: string,
  stage: Stage,
  input: Input,
  change: Setup,
  code = "guard_failed",
) {
  it(name, () => {
    const f = fixture(stage);
    f.observations.inputs = [input];
    change(f);
    const r = fixed(f.state, f.observations);
    expect(r.inputs[0]).toMatchObject({ accepted: false, error: { code } });
  });
}
describe("transition guards fail independently", () => {
  for (const reason of [
    "dependency",
    "capacity-total",
    "capacity-provider",
    "cooldown",
    "blocked",
    "failed",
  ])
    for (const accepted of [false, true])
      it(`#${accepted ? 4 : 3} ${reason}`, () => {
        const f = fixture("todo");
        if (f.state.plan) f.state.plan.accepted = accepted;
        if (reason === "dependency")
          f.state.task.blockedBy = ["missing" as typeof f.state.task.id];
        if (reason === "capacity-total") f.observations.capacity.caps.total = 0;
        if (reason === "capacity-provider")
          f.observations.capacity.caps.codex = 0;
        if (reason === "cooldown")
          f.observations.capacity.coolingDownUntil.codex =
            "2026-09-13T00:00:00.000Z" as typeof now;
        if (reason === "blocked") blockReview(f);
        if (reason === "failed")
          f.state.task.failed = {
            reason: "action_failed",
            since: now,
            detail: "Failed",
            runId: null,
          };
        const result = fixed(f.state, f.observations);
        expect(result.next.task.stage).toBe("todo");
        expect(result.actions.some((a) => a.kind === "start_run")).toBe(false);
      });
  for (const field of ["goal", "steps", "acceptanceCriteria"] as const)
    reject(
      `#5/#6 invalid plan ${field}`,
      "planning",
      mcp(
        {
          tool: "submit_plan",
          input: { plan: { ...plan, [field]: field === "goal" ? "" : [] } },
        },
        "planner",
      ),
      () => {},
      "invalid_input",
    );
  reject(
    "#6 capacity",
    "planning",
    mcp({ tool: "submit_plan", input: { plan } }, "planner"),
    noCapacity,
  );
  reject(
    "#7 stale plan",
    "plan_approval",
    command({ type: "approve_plan", planVersion: 2 }),
    () => {},
  );
  reject(
    "#7 capacity",
    "plan_approval",
    command({ type: "approve_plan", planVersion: 1 }),
    noCapacity,
  );
  for (const mutation of [
    "head",
    "dirty",
    "ahead",
    "git-unknown",
    "missing-tree",
    "commit",
  ] as const)
    reject(`#9 ${mutation}`, "in_progress", mcp(submit()), (f) => {
      if (mutation === "git-unknown")
        f.observations.git = { ok: false, at: now, reason: "offline" };
      if (mutation === "missing-tree") f.state.worktree = null;
      if (mutation === "commit")
        f.state.findings = [finding("f1", { status: "addressed" })];
      if (f.observations.git?.ok) {
        if (mutation === "head") f.observations.git.value.headSha = base;
        if (mutation === "dirty") {
          f.observations.git.value.dirty = true;
          f.observations.git.value.dirtyPaths = ["src/dirty.ts"];
        }
        if (mutation === "ahead") f.observations.git.value.aheadOfBase = 0;
      }
    });
  for (const mutation of [
    "round-head",
    "pr-head",
    "github-unknown",
    "missing-verdict",
    "duplicate-verdict",
    "unexpected-verdict",
    "anchor",
    "drafts",
    "ci-failure",
    "ci-head",
    "conflict",
    "mergeability-unknown",
  ] as const) {
    const call = reviewCall();
    if (call.tool !== "submit_review") continue;
    if (mutation === "anchor") {
      call.input.findings = [
        {
          severity: "minor",
          title: "Line",
          body: "Bad",
          location: {
            path: "missing.ts",
            side: "new",
            startLine: 1,
            endLine: 2,
          },
        },
      ];
      call.drafts = [{ id: finding().id, anchor: null }];
    }
    if (mutation === "drafts")
      call.drafts = [{ id: finding().id, anchor: null }];
    reject(`#10/11/12 ${mutation}`, "in_review", mcp(call, "reviewer"), (f) => {
      if (mutation === "round-head" && f.state.review)
        f.state.review.headSha = base;
      if (mutation === "github-unknown")
        f.observations.github = { ok: false, at: now, reason: "offline" };
      if (mutation.includes("verdict")) {
        f.state.findings = [finding("f1", { status: "addressed" })];
        if (f.state.review) f.state.review.verdictIds = [finding().id];
        if (mutation === "duplicate-verdict")
          call.input.verdicts = [
            { findingId: finding().id, status: "resolved", note: "" },
            { findingId: finding().id, status: "resolved", note: "" },
          ];
        if (mutation === "unexpected-verdict")
          call.input.verdicts = [
            { findingId: finding().id, status: "resolved", note: "" },
            { findingId: finding("other").id, status: "resolved", note: "" },
          ];
      }
      if (f.observations.github?.ok && f.observations.github.value) {
        const pr = f.observations.github.value;
        if (mutation === "pr-head") pr.headSha = base;
        if (mutation === "ci-failure") pr.ci.conclusion = "failure";
        if (mutation === "ci-head") pr.ci.headSha = base;
        if (mutation === "conflict") pr.mergeable = "conflicting";
        if (mutation === "mergeability-unknown") pr.mergeable = "unknown";
      }
    });
  }
  reject(
    "#13 requires review escalation",
    "in_review",
    command({ type: "grant_review_round" }),
    () => {},
    "wrong_stage",
  );
  it("#14 does not advance with another blocker", () => {
    const f = fixture("in_review");
    blockReview(f);
    f.state.findings.push(finding("f2"));
    f.observations.inputs = [
      command({ type: "waive_finding", findingId: finding().id, note: "" }),
    ];
    expect(fixed(f.state, f.observations).next.task.stage).toBe("in_review");
  });
  for (const mutation of [
    "head",
    "review-head",
    "blocking",
    "ci-head",
    "github-unknown",
    "conflict",
    "unknown-mergeability",
  ])
    reject(
      `#15 ${mutation}`,
      "awaiting_approval",
      command({ type: "approve", headSha: head }),
      (f) => {
        if (mutation === "head")
          f.observations.inputs = [command({ type: "approve", headSha: base })];
        if (mutation === "review-head") f.state.review = null;
        if (mutation === "blocking") f.state.findings = [finding()];
        if (mutation === "github-unknown")
          f.observations.github = { ok: false, at: now, reason: "offline" };
        if (f.observations.github?.ok && f.observations.github.value) {
          const pr = f.observations.github.value;
          if (mutation === "ci-head") pr.ci.headSha = base;
          if (mutation === "conflict") pr.mergeable = "conflicting";
          if (mutation === "unknown-mergeability") pr.mergeable = "unknown";
        }
      },
    );
  reject(
    "#18 needs findings",
    "awaiting_approval",
    command({ type: "request_changes", findings: [] }),
    () => {},
  );
  reject("#22 unavailable PR", "canceled", command({ type: "reopen" }), (f) => {
    f.observations.github = { ok: false, at: now, reason: "offline" };
  });
  for (const stage of ["done", "canceled", "merging"] as const)
    reject(
      `#23 refuses ${stage}`,
      stage,
      command({ type: "move", to: "backlog" }),
      () => {},
      "wrong_stage",
    );
  for (const stage of ["done", "canceled"] as const)
    reject(
      `#21 refuses ${stage}`,
      stage,
      command({ type: "cancel", reason: "" }),
      () => {},
      "wrong_stage",
    );
  for (const stage of ["planning", "in_review", "done"] as const)
    reject(
      `#1 refuses ${stage}`,
      stage,
      command({ type: "move", to: "todo" }),
      () => {},
      "wrong_stage",
    );
});

describe("review and merge precedence", () => {
  it("explicitly re-escalated findings stop a nonconverging review below cap", () => {
    const f = fixture("in_review");
    f.state.findings = [finding("f1", { status: "addressed" })];
    if (f.state.review) f.state.review.verdictIds = [finding().id];
    const call = reviewCall();
    if (call.tool === "submit_review")
      call.input.verdicts = [
        {
          findingId: finding().id,
          status: "escalate",
          note: "Still broken",
          reason: "Requires redesign",
        },
      ];
    f.observations.inputs = [mcp(call, "reviewer")];
    expect(fixed(f.state, f.observations).next.task.blocked?.reason).toBe(
      "review_not_converging",
    );
  });
  it("nondecreasing blocking count escalates", () => {
    const f = fixture("in_review");
    if (f.state.review) f.state.review.previousBlocking = 1;
    f.observations.inputs = [mcp(reviewCall([finding()]), "reviewer")];
    expect(fixed(f.state, f.observations).next.task.blocked?.reason).toBe(
      "review_not_converging",
    );
  });
  for (const stage of [
    "backlog",
    "todo",
    "planning",
    "plan_approval",
    "in_progress",
    "in_review",
    "awaiting_approval",
    "merging",
    "canceled",
  ] as const)
    it(`#20 observes merge from ${stage}`, () => {
      const f = fixture(stage);
      merged(f);
      expect(fixed(f.state, f.observations).next.task.stage).toBe("done");
    });
  it("a moved head wins over failing CI", () => {
    const f = fixture("merging");
    if (f.observations.github?.ok && f.observations.github.value) {
      f.observations.github.value.headSha = base;
      f.observations.github.value.ci.conclusion = "failure";
    }
    expect(fixed(f.state, f.observations).next.task.stage).toBe("in_review");
  });
  it("pending CI uses auto merge and captures findings snapshot", () => {
    const f = fixture("awaiting_approval");
    if (f.observations.github?.ok && f.observations.github.value)
      f.observations.github.value.ci.conclusion = "pending";
    f.observations.inputs = [command({ type: "approve", headSha: head })];
    const r = fixed(f.state, f.observations);
    expect(r.actions.find((a) => a.kind === "merge_pr")).toMatchObject({
      auto: true,
      matchHeadSha: head,
    });
    expect(r.next.approvals[0]).toMatchObject({
      kind: "merge",
      headSha: head,
      findings: { openBlocking: 0 },
    });
  });
  describe("small task fast path", () => {
    it("small task auto-generates plan and skips planning stage", () => {
      const f = fixture("todo");
      f.state.task.size = "small";
      f.state.task.title = "Fix typo";
      f.state.task.description = "Update documentation\nFix spelling";
      f.state.plan = null;
      const r = fixed(f.state, f.observations);
      expect(r.next.plan).toBeDefined();
      expect(r.next.plan?.goal).toBe("Fix typo");
      expect(r.next.plan?.accepted).toBe(true);
      expect(r.next.plan?.steps).toHaveLength(2);
      expect(r.next.plan?.steps[0]?.title).toBe("Update documentation");
    });
    it("small task goes directly to in_progress when capacity allows", () => {
      const f = fixture("todo");
      f.state.task.size = "small";
      f.state.plan = null;
      const r = fixed(f.state, f.observations);
      expect(r.next.task.stage).toBe("in_progress");
    });
    it("normal task still goes through planning", () => {
      const f = fixture("todo");
      f.state.task.size = "normal";
      f.state.plan = null;
      const r = fixed(f.state, f.observations);
      expect(r.next.task.stage).toBe("planning");
    });
  });
});
