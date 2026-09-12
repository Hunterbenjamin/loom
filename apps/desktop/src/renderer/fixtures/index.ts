// The whole app renders from this snapshot. It stands in for what the coordinator will send
// over `packages/protocol`, so it is built out of `@loom/core`'s entity types on purpose:
// this is the first consumer those types have.

import type {
  Approval,
  AttentionReason,
  Finding,
  FindingStatus,
  IsoTime,
  Message,
  Plan,
  Provider,
  Question,
  Repo,
  Role,
  Run,
  RunStatus,
  Severity,
  Stage,
  Task,
  TaskId,
  TestResult,
  Transition,
  Worktree,
} from "@loom/core";
import {
  approvalId,
  blobOid,
  findingId,
  inputId,
  isoTime,
  messageId,
  minutesBefore,
  NOW,
  questionId,
  repoId,
  runId,
  sessionId,
  sha,
  taskId,
  transitionId,
  worktreePath,
} from "./ids.js";
import { buildPatch, type PatchFixture } from "./patch.js";
import { between, pick, rng } from "./rng.js";

/** A human comment thread on a finding. `@loom/core` has no reply type; see the PR notes. */
export interface Comment {
  id: string;
  findingId: string;
  author: string;
  body: string;
  at: IsoTime;
}

export interface Snapshot {
  now: IsoTime;
  repos: Repo[];
  tasks: Task[];
  worktrees: Worktree[];
  runs: Run[];
  questions: Question[];
  messages: Message[];
  findings: Finding[];
  approvals: Approval[];
  plans: Record<string, Plan>;
  testResults: TestResult[];
  transitions: Transition[];
  comments: Comment[];
  /** Review-shell state the coordinator will own; Pierre has none of it (spike 04). */
  viewedFiles: Record<string, string[]>;
  patch: PatchFixture;
}

export const STAGES: Stage[] = [
  "backlog",
  "todo",
  "planning",
  "plan_approval",
  "in_progress",
  "in_review",
  "awaiting_approval",
  "merging",
  "done",
  "canceled",
];

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: "Backlog",
  todo: "Todo",
  planning: "Planning",
  plan_approval: "Plan approval",
  in_progress: "In progress",
  in_review: "In review",
  awaiting_approval: "Awaiting approval",
  merging: "Merging",
  done: "Done",
  canceled: "Canceled",
};

const LONG_TITLE =
  "Reconcile Codex threads whose app-server generation changed while a blocking approval " +
  "request was outstanding, without losing the request ID or double-answering it after the " +
  "coordinator restarts mid-turn";

/** Title, stage, repo. Hand-written so the awkward cases sit where they make sense. */
const SEEDS: [title: string, stage: Stage, repo: 0 | 1][] = [
  ["Record provider session IDs before launch", "backlog", 0],
  ["Add a cost budget per task", "backlog", 0],
  ["Teach the reconciler about external sessions", "backlog", 1],
  [LONG_TITLE, "todo", 0],
  ["Port the stage rules to a table", "backlog", 0],
  ["Spike: ghostty-web mouse reporting", "backlog", 1],
  ["Warn when two tasks touch the same area", "backlog", 0],
  ["Split findings.json per review round", "todo", 0],
  ["Refuse prompts that start with / or !", "todo", 1],
  ["Keep .task out of git via info/exclude", "todo", 0],
  ["Scrub CLAUDE_CODE_* from spawned environments", "todo", 1],
  ["Resume a vanished interactive run", "planning", 0],
  ["Map finding anchors across a rebase", "planning", 0],
  ["Bound the worker pool by CPU count", "planning", 1],
  ["Add the merge queue lock for serial-test repos", "plan_approval", 0],
  ["Answer Codex approvals from the task view", "plan_approval", 0],
  ["Cache GitHub check runs per head SHA", "plan_approval", 1],
  ["Implement stage transitions in packages/core", "in_progress", 0],
  ["Write the SQLite schema and migrations", "in_progress", 0],
  ["Claude hook server with per-session settings", "in_progress", 1],
  ["Codex app-server adapter: thread lifecycle", "in_progress", 0],
  ["Herdr adapter: agent start, attach, prompt", "in_progress", 1],
  ["Retry headless runs with capped backoff", "in_progress", 0],
  ["Detect stalls without killing the run", "in_progress", 0],
  ["Review shell: file list, viewed state, jumps", "in_review", 0],
  ["Findings MCP tool with anchor validation", "in_review", 0],
  ["Idempotent PR reconcile", "in_review", 1],
  ["Void approvals on a new commit", "in_review", 0],
  ["Plan approval round trip", "in_review", 1],
  ["Worktree create and remove", "in_review", 0],
  ["Squash merge with --match-head-commit", "awaiting_approval", 0],
  ["Attention flags for rate-limited providers", "awaiting_approval", 0],
  ["Transition log in the activity tab", "awaiting_approval", 1],
  ["Capacity caps per provider", "awaiting_approval", 0],
  ["Open the pane in Ghostty", "merging", 1],
  ["Kitty key encoder for Shift+Enter", "merging", 0],
  ["Coordinator CLI: loom status", "done", 0],
  ["Fake agent for tests", "done", 0],
  ["Electron shell with a loopback renderer", "done", 1],
  ["Drop ghostty-web from the stack", "canceled", 1],
];

const THREE_RUNS = 7;
const PERMISSION = 11;
const FAILED = 22;
const MANY_FINDINGS = 25;

const MODELS: Record<Provider, string[]> = {
  codex: ["gpt-5.3-codex", "gpt-5.3-codex-spark"],
  claude: ["claude-opus-5", "claude-haiku-4-5-20251001"],
};

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

const STAGE_ROLES: Partial<Record<Stage, Role[]>> = {
  planning: ["planner"],
  plan_approval: ["planner"],
  in_progress: ["planner", "implementer"],
  in_review: ["planner", "implementer", "reviewer"],
  awaiting_approval: ["planner", "implementer", "reviewer"],
  merging: ["planner", "implementer", "reviewer"],
  done: ["planner", "implementer", "reviewer"],
  canceled: ["planner", "implementer"],
};

const HAS_WORKTREE: Stage[] = [
  "planning",
  "plan_approval",
  "in_progress",
  "in_review",
  "awaiting_approval",
  "merging",
  "done",
];

function attentionFor(reasons: AttentionReason[], since: IsoTime | null) {
  const reasonSince: Partial<Record<AttentionReason, IsoTime>> = {};
  // One `since` per reason: the first is the set's own, later ones are more recent, so the
  // set's `since` stays the earliest and a sorted inbox has something to sort.
  const age = since ? minutesAgo(since) : 0;
  reasons.forEach((reason, i) => {
    if (since) reasonSince[reason] = minutesBefore(Math.round(age / (i + 1)));
  });
  return { reasons, reasonSince, since: reasons.length > 0 ? since : null };
}

const minutesAgo = (at: IsoTime): number =>
  Math.round((Date.parse(NOW) - Date.parse(at)) / 60_000);

/**
 * `taskCount` repeats the seed list to make a longer list. The app always uses the 40 written
 * below; the performance harness asks for 500 to measure scrolling.
 */
export function buildSnapshot(taskCount = SEEDS.length): Snapshot {
  const random = rng(0xf00d);
  const repos: Repo[] = [
    {
      id: repoId("repo-loom"),
      root: worktreePath("/Users/you/Projects/loom"),
      github: "you/loom",
      baseBranch: "main",
      defaultProviders: {
        planner: "codex",
        implementer: "claude",
        reviewer: "codex",
      },
      serialTests: false,
    },
    {
      id: repoId("repo-herdr"),
      root: worktreePath("/Users/you/Projects/herdr"),
      github: "you/herdr",
      baseBranch: "main",
      defaultProviders: {
        planner: "claude",
        implementer: "codex",
        reviewer: "claude",
      },
      serialTests: true,
    },
  ];

  const tasks: Task[] = [];
  const worktrees: Worktree[] = [];
  const runs: Run[] = [];
  const questions: Question[] = [];
  const messages: Message[] = [];
  const findings: Finding[] = [];
  const approvals: Approval[] = [];
  const plans: Record<string, Plan> = {};
  const testResults: TestResult[] = [];
  const transitions: Transition[] = [];
  const comments: Comment[] = [];
  const viewedFiles: Record<string, string[]> = {};
  const patch = buildPatch(50);

  const seeds: typeof SEEDS = [];
  for (let i = 0; i < taskCount; i += 1) {
    const seed = SEEDS[i % SEEDS.length];
    if (seed)
      seeds.push(
        i < SEEDS.length
          ? seed
          : [`${seed[0]} (${Math.floor(i / SEEDS.length)})`, seed[1], seed[2]],
      );
  }

  seeds.forEach(([title, stage, repoIndex], index) => {
    const repo = repos[repoIndex] as Repo;
    const id = taskId(`LOOM-${String(index + 101)}`);
    const branch = `feat/${slug(title)}`;
    const ageMinutes = between(random, 12, 60 * 96);
    const stageMinutes = Math.min(ageMinutes, between(random, 4, 60 * 30));
    const hasWorktree = HAS_WORKTREE.includes(stage);
    const path = worktreePath(`${repo.root}/../worktrees/${slug(title)}`);

    const reasons: AttentionReason[] = [];
    if (stage === "plan_approval") reasons.push("plan_needs_approval");
    if (stage === "awaiting_approval") reasons.push("needs_approval");
    if (index === PERMISSION) reasons.push("provider_permission");
    if (index === FAILED) reasons.push("failed");
    if (index === 23) reasons.push("stalled");
    if (index === 12) reasons.push("question");
    if (index === 26) reasons.push("status_unknown");
    if (index === 33) reasons.push("over_budget");

    const task: Task = {
      id,
      repoId: repo.id,
      title,
      description:
        `Part of the ${STAGE_LABELS[stage].toLowerCase()} work in ${repo.github}. ` +
        "The coordinator owns the stage; this card is a view of it.",
      stage,
      stageEnteredAt: minutesBefore(stageMinutes),
      version: between(random, 3, 40),
      blocked:
        index === 12
          ? {
              reason: "question",
              since: minutesBefore(96),
              detail:
                "Waiting on: which base branch should the merge queue target?",
              until: null,
              questionId: questionId(`${id}-q1`),
            }
          : index === 26
            ? {
                reason: "provider_cooling_down",
                since: minutesBefore(31),
                detail:
                  "Codex usage limit reached; queued until the window resets.",
                until: minutesBefore(-64),
                questionId: null,
              }
            : null,
      failed:
        index === FAILED
          ? {
              reason: "retries_exhausted",
              since: minutesBefore(140),
              detail:
                "The implementer run failed 3 times: `pnpm test` exited 1 before any edit.",
              runId: runId(`${id}/implementer/0`),
            }
          : null,
      requirePlanApproval: stage !== "backlog" && index % 3 !== 1,
      reviewRound:
        stage === "in_review"
          ? between(random, 1, 3)
          : stage === "backlog"
            ? 0
            : 1,
      reviewRoundCap: 3,
      providers: repo.defaultProviders,
      blockedBy: index === 22 ? [taskId("LOOM-118")] : [],
      budgetMinutes: index % 4 === 0 ? 180 : null,
      createdAt: minutesBefore(ageMinutes),
      updatedAt: minutesBefore(between(random, 1, stageMinutes)),
      worktreePath: hasWorktree ? path : null,
      branch: hasWorktree ? branch : null,
      prNumber: ["in_review", "awaiting_approval", "merging", "done"].includes(
        stage,
      )
        ? 400 + index
        : null,
      attention: attentionFor(reasons, minutesBefore(between(random, 3, 200))),
    };
    tasks.push(task);

    if (hasWorktree) {
      worktrees.push({
        path,
        taskId: id,
        repoId: repo.id,
        branch,
        baseBranch: repo.baseBranch,
        baseSha: sha(index * 7 + 1),
        portSlot: index % 8,
        herdrWorkspaceId: `w${index % 5}`,
        createdAt: minutesBefore(stageMinutes + 20),
        removedAt: stage === "done" ? minutesBefore(2) : null,
        git: {
          headSha: sha(index * 13 + 5),
          dirty: index % 6 === 0,
          aheadOfBase: between(random, 1, 14),
          at: minutesBefore(1),
        },
      });
    }

    // ---- runs
    const roles = STAGE_ROLES[stage] ?? [];
    roles.forEach((role, roleIndex) => {
      const provider = task.providers[role];
      const isLast = roleIndex === roles.length - 1;
      const round = role === "reviewer" ? task.reviewRound - 1 : 0;
      let status: RunStatus = "ended";
      let blockedOn: Run["blockedOn"] = null;
      if (isLast && ["planning", "in_progress", "in_review"].includes(stage))
        status = "working";
      if (isLast && index === PERMISSION) {
        status = "blocked";
        blockedOn = "permission";
      }
      if (isLast && index === FAILED) status = "failed";
      if (isLast && index === 26) status = "unknown";
      if (isLast && index === 23) status = "idle";

      runs.push({
        id: runId(`${id}/${role}/${round}`),
        taskId: id,
        role,
        provider,
        mode: role === "implementer" ? "interactive" : "headless",
        origin: "loom",
        worktreePath: path,
        round,
        attempts: index === FAILED && role === "implementer" ? 3 : 1,
        model: pick(random, MODELS[provider]),
        sessionId: sessionId(
          provider === "claude"
            ? `9f2c${index.toString(16).padStart(2, "0")}-${roleIndex}a4e-4c11-9b7d-${sha(index).slice(0, 12)}`
            : `thread_${sha(index * 3 + roleIndex).slice(0, 16)}`,
        ),
        sessionEpoch: index === FAILED ? 2 : 1,
        codexGeneration: provider === "codex" ? 4 : null,
        herdr:
          role === "implementer"
            ? {
                agentName: `loom-${slug(title).slice(0, 20)}`,
                paneId: `w${index % 5}:p${roleIndex + 1}`,
              }
            : null,
        status,
        blockedOn,
        lastTurn: {
          id: `turn_${index}${roleIndex}`,
          outcome:
            status === "failed"
              ? "failed"
              : status === "working"
                ? null
                : "completed",
          error:
            status === "failed" ? "command failed: pnpm test (exit 1)" : null,
        },
        pendingRequests:
          status === "blocked"
            ? [
                {
                  id: "req_88",
                  generation: provider === "codex" ? 4 : null,
                  kind: "command_approval",
                  blocking: true,
                  summary:
                    "Run `pnpm --filter @loom/store migrate` in the worktree",
                  receivedAt: minutesBefore(9),
                },
              ]
            : [],
        lastActivityAt: minutesBefore(
          status === "working" ? 1 : between(random, 5, 400),
        ),
        retryAt: status === "failed" ? minutesBefore(-4) : null,
        launchedAt: minutesBefore(stageMinutes + 10 - roleIndex * 3),
        endedAt:
          status === "ended"
            ? minutesBefore(between(random, 2, stageMinutes))
            : null,
        endReason: status === "ended" ? "submitted" : null,
      });
    });

    // A task that has been through three implementer attempts across two rounds.
    if (index === THREE_RUNS) {
      for (const [round, role] of [
        [0, "implementer"],
        [1, "reviewer"],
        [1, "implementer"],
      ] as [number, Role][]) {
        runs.push({
          id: runId(`${id}/${role}/${round}`),
          taskId: id,
          role,
          provider: task.providers[role],
          mode: role === "implementer" ? "interactive" : "headless",
          origin: round === 1 && role === "implementer" ? "external" : "loom",
          worktreePath: path,
          round,
          attempts: round + 1,
          model: pick(random, MODELS[task.providers[role]]),
          sessionId: sessionId(
            `thread_${sha(index * 97 + round).slice(0, 16)}`,
          ),
          sessionEpoch: 1,
          codexGeneration: task.providers[role] === "codex" ? 4 : null,
          herdr:
            role === "implementer"
              ? { agentName: `loom-${slug(title)}`, paneId: `w2:p${round + 1}` }
              : null,
          status: round === 1 && role === "implementer" ? "working" : "ended",
          blockedOn: null,
          lastTurn: { id: `turn_x${round}`, outcome: "completed", error: null },
          pendingRequests: [],
          lastActivityAt: minutesBefore(round === 1 ? 2 : 300),
          retryAt: null,
          launchedAt: minutesBefore(400 - round * 100),
          endedAt:
            round === 1 && role === "implementer"
              ? null
              : minutesBefore(320 - round * 90),
          endReason: round === 1 && role === "implementer" ? null : "submitted",
        });
      }
    }

    // ---- plan
    if (stage !== "backlog" && stage !== "todo") {
      plans[id] = {
        goal: title,
        nonGoals: ["Change the stage rules", "Touch the merge path"],
        steps: [
          {
            title: "Read the owner",
            detail: "Establish which tool owns the fact being changed.",
          },
          {
            title: "Add the types",
            detail: "Extend `@loom/core` without adding I/O.",
          },
          {
            title: "Wire the adapter",
            detail: "Validate the external payload with zod at the boundary.",
          },
          {
            title: "Reconcile",
            detail: "Make the handler idempotent: twice is the same as once.",
          },
        ],
        areas: [
          "packages/core/src",
          "packages/adapters/*",
          "apps/coordinator/src",
        ],
        acceptanceCriteria: [
          "`pnpm test`, `pnpm lint` and `pnpm typecheck` pass",
          "Running the handler twice changes nothing the second time",
        ],
        testPlan: [
          "Unit tests next to the code",
          "A fake-agent run through the whole stage",
        ],
        risks: ["The provider's event order is not guaranteed"],
        openQuestions:
          index === 12
            ? ["Which base branch should the merge queue target?"]
            : [],
        suggestedImplementer: task.providers.implementer,
      };
    }

    // ---- questions and messages
    if (index === 12) {
      questions.push({
        id: questionId(`${id}-q1`),
        taskId: id,
        runId: runId(`${id}/planner/0`),
        question: "Which base branch should the merge queue target?",
        options: ["main", "release/next"],
        blocking: true,
        askedAt: minutesBefore(96),
        answer: null,
        answeredAt: null,
      });
    }
    messages.push({
      id: messageId(`${id}-m1`),
      runId: runId(`${id}/${roles[0] ?? "planner"}/0`),
      purpose: "initial",
      text: `Work the task "${title}". Follow AGENTS.md.`,
      textHash: sha(index * 31).slice(0, 16),
      status: "delivered",
      attempts: 1,
      transportRef: `turn_${index}0`,
      sentAt: minutesBefore(stageMinutes + 9),
      delivered: {
        via: "codex_turn_started",
        turnId: `turn_${index}0`,
        at: minutesBefore(stageMinutes + 9),
      },
    });

    // ---- findings
    const findingCount =
      index === MANY_FINDINGS
        ? 200
        : stage === "in_review"
          ? between(random, 2, 9)
          : 0;
    // Binary files have no lines to anchor to, so findings only land on the text ones.
    const anchorable = patch.files.filter((file) => file.status !== "binary");
    for (let f = 0; f < findingCount; f += 1) {
      const file = anchorable[f % anchorable.length];
      if (!file) continue;
      const severity = pick<Severity>(random, [
        "blocker",
        "major",
        "minor",
        "nit",
      ]);
      const status = pick<FindingStatus>(random, [
        "open",
        "open",
        "open",
        "addressed",
        "disputed",
        "resolved",
        "waived",
      ]);
      const mapping =
        f % 17 === 0
          ? "moved"
          : f % 23 === 0
            ? "outdated"
            : f % 29 === 0
              ? "ambiguous"
              : "exact";
      const line = 7 + ((f * 13) % 60);
      findings.push({
        id: findingId(`${id}-f${f}`),
        taskId: id,
        round: task.reviewRound - (f % 2),
        source: f % 11 === 0 ? "ci" : f % 7 === 0 ? "human" : "reviewer",
        externalId: f % 11 === 0 ? `check_${f}` : null,
        createdByRunId: runId(
          `${id}/reviewer/${Math.max(0, task.reviewRound - 1)}`,
        ),
        severity,
        blocking: severity === "blocker" || severity === "major",
        title:
          f % 3 === 0
            ? "Handler is not idempotent"
            : f % 3 === 1
              ? "External payload reaches core unvalidated"
              : "Stage change happens before the write commits",
        body:
          "Running this twice writes the transition twice. Take the compare-and-set on `version` " +
          "before appending, and return early when the row is already at the target stage.",
        status,
        reopenCount: f % 19 === 0 ? 1 : 0,
        anchor: {
          baseSha: sha(index * 7 + 1),
          headSha: sha(index * 13 + 5),
          oldPath: file.path,
          newPath: file.path,
          oldBlobOid: blobOid(f * 3 + 2),
          newBlobOid: blobOid(f * 5 + 3),
          side: "new",
          startLine: line,
          endLine: line,
          startColumn: null,
          endColumn: null,
          selectedText: `    if (run.status === "working") total += ${(f % 9) + 1};`,
          selectedTextHash: sha(f * 11).slice(0, 16),
          contextBeforeHash: sha(f * 17).slice(0, 16),
          contextAfterHash: sha(f * 19).slice(0, 16),
          normalization: "lf-v1",
        },
        location: {
          headSha: sha(index * 13 + 5),
          path: mapping === "outdated" ? null : file.path,
          blobOid: blobOid(f * 5 + 3),
          side: "new",
          startLine:
            mapping === "outdated"
              ? null
              : mapping === "moved"
                ? line + 5
                : line,
          endLine:
            mapping === "outdated"
              ? null
              : mapping === "moved"
                ? line + 5
                : line,
          status: mapping,
          version: 2,
          mappedAt: minutesBefore(3),
        },
        resolution:
          status === "resolved" || status === "waived"
            ? {
                by: status === "waived" ? "human" : "implementer",
                note:
                  status === "waived"
                    ? "Accepted for this branch."
                    : "Fixed in the next commit.",
                commitSha: sha(index * 13 + 5),
                at: minutesBefore(between(random, 2, 80)),
              }
            : null,
        createdAt: minutesBefore(between(random, 10, 300)),
        updatedAt: minutesBefore(between(random, 1, 10)),
      });
      if (f % 12 === 0) {
        comments.push({
          id: `${id}-c${f}`,
          findingId: `${id}-f${f}`,
          author: "you",
          body: "Agreed, but do the early return before the transaction opens.",
          at: minutesBefore(between(random, 2, 40)),
        });
        comments.push({
          id: `${id}-c${f}b`,
          findingId: `${id}-f${f}`,
          author: task.providers.implementer,
          body: "Moved the check above `begin`. New commit pushed.",
          at: minutesBefore(between(random, 1, 2)),
        });
      }
    }

    if (stage === "in_review" || stage === "awaiting_approval") {
      viewedFiles[id] = patch.files.slice(0, index % 7).map((f) => f.path);
    }

    // ---- approvals
    if (stage === "plan_approval") {
      // No approval yet: that is what the human is looking at.
    } else if (["merging", "done"].includes(stage)) {
      approvals.push({
        id: approvalId(`${id}-a1`),
        taskId: id,
        kind: "merge",
        headSha: sha(index * 13 + 5),
        findings: {
          hash: sha(index * 23).slice(0, 16),
          findings: [],
          openBlocking: 0,
        },
        ci: {
          headSha: sha(index * 13 + 5),
          conclusion: "success",
          checks: [
            {
              id: `ci-${index}-test`,
              name: "test",
              status: "completed",
              conclusion: "success",
              url: null,
            },
            {
              id: `ci-${index}-lint`,
              name: "lint",
              status: "completed",
              conclusion: "success",
              url: null,
            },
          ],
          observedAt: minutesBefore(4),
        },
        createdAt: minutesBefore(between(random, 5, 60)),
        voidedAt: null,
        voidReason: null,
      });
    } else if (stage === "in_progress" && index % 5 === 0) {
      approvals.push({
        id: approvalId(`${id}-a0`),
        taskId: id,
        kind: "plan",
        planVersion: 1,
        createdAt: minutesBefore(between(random, 60, 400)),
        voidedAt: minutesBefore(between(random, 1, 50)),
        voidReason: "plan_changed",
      });
    }

    // ---- test results
    if (hasWorktree) {
      testResults.push({
        command: "pnpm test",
        outcome: index === FAILED ? "failed" : "passed",
        summary:
          index === FAILED
            ? "3 failed, 118 passed (packages/core/src/reconcile.test.ts)"
            : "121 passed",
        headSha: sha(index * 13 + 5),
        ranAt: minutesBefore(between(random, 3, 90)),
        runId: runId(`${id}/implementer/0`),
      });
      testResults.push({
        command: "pnpm lint",
        outcome: "passed",
        summary: "Checked 214 files, no fixes applied",
        headSha: sha(index * 13 + 5),
        ranAt: minutesBefore(between(random, 3, 90)),
        runId: runId(`${id}/implementer/0`),
      });
    }

    // ---- transition log
    const path2 = STAGES.slice(0, STAGES.indexOf(stage) + 1).filter(
      (s) => s !== "canceled",
    );
    let previous: Stage = "backlog";
    path2.forEach((to, step) => {
      if (step === 0) return;
      transitions.push({
        id: transitionId(`${id}-t${step}`),
        taskId: id,
        at: minutesBefore(
          ageMinutes - step * Math.floor(ageMinutes / (path2.length + 1)),
        ),
        from: previous,
        to,
        flags: {},
        trigger:
          to === "in_review"
            ? {
                kind: "mcp",
                tool: "submit_work",
                runId: runId(`${id}/implementer/0`),
                inputId: inputId(`${id}-i${step}`),
              }
            : to === "todo"
              ? {
                  kind: "human",
                  command: "move",
                  inputId: inputId(`${id}-i${step}`),
                }
              : {
                  kind: "reconcile",
                  fact: `run ${id}/${roles[0] ?? "planner"}/0 ended`,
                },
        reason: `Entered ${STAGE_LABELS[to].toLowerCase()}.`,
        taskVersion: step + 1,
      });
      previous = to;
    });
    if (task.blocked) {
      transitions.push({
        id: transitionId(`${id}-tb`),
        taskId: id,
        at: task.blocked.since,
        from: stage,
        to: stage,
        flags: { blocked: { from: null, to: task.blocked.reason } },
        trigger: { kind: "reconcile", fact: task.blocked.detail },
        reason: task.blocked.detail,
        taskVersion: task.version,
      });
    }
    if (task.failed) {
      transitions.push({
        id: transitionId(`${id}-tf`),
        taskId: id,
        at: task.failed.since,
        from: stage,
        to: stage,
        flags: { failed: { from: null, to: task.failed.reason } },
        trigger: { kind: "reconcile", fact: "3 attempts failed" },
        reason: task.failed.detail,
        taskVersion: task.version,
      });
    }
  });

  transitions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    now: NOW,
    repos,
    tasks,
    worktrees,
    runs,
    questions,
    messages,
    findings,
    approvals,
    plans,
    testResults,
    transitions,
    comments,
    viewedFiles,
    patch,
  };
}

export type { TaskId };
export { isoTime, NOW };
