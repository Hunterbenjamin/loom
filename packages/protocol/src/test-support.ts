// A small snapshot with one of everything, including the awkward rows: a task that needs the
// human for two reasons with different `since` times, an external run, a renamed file, a binary
// file, an unsent draft. Tests build from here so a schema change shows up in one place.

import type { z } from "zod";
import {
  approvalId,
  blobOid,
  fileId,
  findingId,
  inputId,
  isoTime,
  messageId,
  providerSessionId,
  questionId,
  repoId,
  runId,
  sha as shaSchema,
  taskId,
  threadId,
  transitionId,
  worktreePath,
} from "./ids.js";
import type { Change, PatchBody } from "./patch.js";
import type { SnapshotBody, SnapshotMeta } from "./snapshot.js";
import { changesKey } from "./views.js";

const parse = <T>(schema: z.ZodType<T>, value: unknown): T =>
  schema.parse(value);

export const at = (iso: string) => parse(isoTime, iso);
export const id = {
  repo: (v: string) => parse(repoId, v),
  task: (v: string) => parse(taskId, v),
  run: (v: string) => parse(runId, v),
  message: (v: string) => parse(messageId, v),
  question: (v: string) => parse(questionId, v),
  finding: (v: string) => parse(findingId, v),
  approval: (v: string) => parse(approvalId, v),
  transition: (v: string) => parse(transitionId, v),
  thread: (v: string) => parse(threadId, v),
  input: (v: string) => parse(inputId, v),
  session: (v: string) => parse(providerSessionId, v),
  file: (v: string) => parse(fileId, v),
  worktree: (v: string) => parse(worktreePath, v),
};

const hex = (seed: number) =>
  seed.toString(16).padStart(2, "0").repeat(20).slice(0, 40);

export const sha = (seed: number) => parse(shaSchema, hex(seed));
export const oid = (seed: number) => parse(blobOid, hex(seed));

const NOW = at("2026-09-12T09:00:00.000Z");
const REPO = id.repo("repo-loom");
const WT = id.worktree("/private/var/loom/wt/LOOM-101");

export const meta: SnapshotMeta = { seq: 41, now: NOW, epoch: "coord-1" };

export function snapshot(): SnapshotBody {
  const task = id.task("LOOM-101");
  const other = id.task("LOOM-102");
  return {
    inbox: [],
    repos: [
      {
        id: REPO,
        root: id.worktree("/private/var/loom/repos/loom"),
        github: "you/loom",
        baseBranch: "main",
        defaultProviders: {
          planner: "codex",
          implementer: "claude",
          reviewer: "codex",
        },
        serialTests: false,
      },
    ],
    tasks: [
      {
        id: task,
        repoId: REPO,
        title: "Write the coordinator to UI protocol",
        description: "Snapshot, patches, subscriptions, commands.",
        stage: "in_review",
        stageEnteredAt: at("2026-09-12T07:00:00.000Z"),
        version: 12,
        blocked: null,
        failed: null,
        requirePlanApproval: true,
        reviewRound: 1,
        reviewRoundCap: 3,
        providers: {
          planner: "codex",
          implementer: "claude",
          reviewer: "codex",
        },
        blockedBy: [],
        budgetMinutes: 180,
        createdAt: at("2026-09-12T05:00:00.000Z"),
        updatedAt: NOW,
        worktreePath: WT,
        branch: "feat/protocol",
        prNumber: 29,
        // Two reasons, each with its own `since`: the point of gap 2.
        attention: {
          reasons: ["provider_permission", "stalled"],
          reasonSince: {
            stalled: at("2026-09-12T06:10:00.000Z"),
            provider_permission: at("2026-09-12T08:55:00.000Z"),
          },
          since: at("2026-09-12T06:10:00.000Z"),
        },
      },
      {
        id: other,
        repoId: REPO,
        title: "Retire the Herdr adapter",
        description: "",
        stage: "done",
        stageEnteredAt: at("2026-09-11T09:00:00.000Z"),
        version: 30,
        blocked: null,
        failed: null,
        requirePlanApproval: false,
        reviewRound: 2,
        reviewRoundCap: 3,
        providers: {
          planner: "claude",
          implementer: "codex",
          reviewer: "claude",
        },
        blockedBy: [],
        budgetMinutes: null,
        createdAt: at("2026-09-10T09:00:00.000Z"),
        updatedAt: at("2026-09-11T09:00:00.000Z"),
        worktreePath: null,
        branch: "feat/adapter-tmux",
        prNumber: 28,
        attention: { reasons: [], reasonSince: {}, since: null },
      },
    ],
    worktrees: [
      {
        path: WT,
        taskId: task,
        repoId: REPO,
        branch: "feat/protocol",
        baseBranch: "main",
        baseSha: sha(1),
        portSlot: 3,
        paneWorkspaceId: null,
        createdAt: at("2026-09-12T05:05:00.000Z"),
        removedAt: null,
        git: { headSha: sha(2), dirty: false, aheadOfBase: 4, at: NOW },
      },
    ],
    runs: [
      {
        id: id.run("LOOM-101/implementer/0"),
        taskId: task,
        role: "implementer",
        provider: "claude",
        mode: "interactive",
        origin: "loom",
        worktreePath: WT,
        round: 0,
        attempts: 1,
        model: "claude-opus-5",
        sessionId: id.session("9f2c0011-0a4e-4c11-9b7d-2b5d0f1a77c3"),
        sessionEpoch: 1,
        codexGeneration: null,
        pane: {
          hostGeneration: "g1",
          sessionName: "loom-protocol",
          windowId: "@1",
          paneId: "%3",
        },
        status: "blocked",
        blockedOn: "permission",
        lastTurn: { id: "turn_9", outcome: null, error: null },
        pendingRequests: [
          {
            id: "req_88",
            generation: null,
            kind: "permission",
            blocking: true,
            summary: "Write packages/protocol/src/index.ts",
            receivedAt: at("2026-09-12T08:55:00.000Z"),
          },
        ],
        lastActivityAt: at("2026-09-12T08:55:00.000Z"),
        retryAt: null,
        launchedAt: at("2026-09-12T06:00:00.000Z"),
        endedAt: null,
        endReason: null,
        seenAt: at("2026-09-12T06:01:00.000Z"),
      },
      {
        id: id.run("LOOM-101/reviewer/0"),
        taskId: task,
        role: "reviewer",
        provider: "codex",
        mode: "headless",
        origin: "external",
        worktreePath: WT,
        round: 0,
        attempts: 1,
        model: "gpt-5.3-codex",
        sessionId: null,
        sessionEpoch: 1,
        codexGeneration: 4,
        pane: null,
        status: "idle",
        blockedOn: null,
        lastTurn: { id: "turn_3", outcome: "completed", error: null },
        pendingRequests: [],
        lastActivityAt: at("2026-09-12T08:00:00.000Z"),
        retryAt: null,
        launchedAt: at("2026-09-12T07:30:00.000Z"),
        endedAt: null,
        endReason: null,
      },
    ],
    runTargets: [
      {
        runId: id.run("LOOM-101/implementer/0"),
        taskId: task,
        sessionId: null,
        attach: {
          kind: "pane_host",
          argv: ["tmux", "-L", "loom-dev", "attach", "-t", "loom-LOOM-101"],
          cwd: WT,
          env: { LOOM_INSTANCE: "dev" },
        },
        pane: {
          hostGeneration: "loom-dev#2",
          sessionName: "loom-LOOM-101",
          windowId: "@4",
          paneId: "%3",
          dead: false,
          exitStatus: null,
          attachedClients: 2,
          size: { cols: 180, rows: 48 },
          observedAt: NOW,
        },
      },
    ],
    messages: [
      {
        id: id.message("LOOM-101-m1"),
        taskId: task,
        runId: id.run("LOOM-101/implementer/0"),
        purpose: "initial",
        text: "Work the task. Follow AGENTS.md.",
        textHash: "e3b0c442",
        status: "delivered",
        attempts: 1,
        transportRef: null,
        sentAt: at("2026-09-12T06:00:00.000Z"),
        delivered: {
          via: "claude_user_prompt_submit",
          promptId: "p1",
          at: at("2026-09-12T06:00:01.000Z"),
        },
        via: "pane_paste",
      },
    ],
    questions: [
      {
        id: id.question("LOOM-101-q1"),
        taskId: task,
        runId: id.run("LOOM-101/implementer/0"),
        question: "Should a delete carry its task ID?",
        options: ["yes", "no"],
        blocking: false,
        askedAt: at("2026-09-12T08:00:00.000Z"),
        answer: "yes",
        answeredAt: at("2026-09-12T08:01:00.000Z"),
      },
    ],
    findings: [
      {
        id: id.finding("LOOM-101-f1"),
        taskId: task,
        round: 1,
        source: "reviewer",
        externalId: null,
        createdByRunId: id.run("LOOM-101/reviewer/0"),
        severity: "major",
        blocking: true,
        title: "A gap in the sequence is not detected",
        body: "Apply the patch only when its seq is exactly the next one.",
        status: "open",
        reopenCount: 0,
        anchor: {
          baseSha: sha(1),
          headSha: sha(2),
          oldPath: "packages/protocol/src/patch.ts",
          newPath: "packages/protocol/src/patch.ts",
          oldBlobOid: oid(3),
          newBlobOid: oid(4),
          side: "new",
          startLine: 120,
          endLine: 124,
          startColumn: null,
          endColumn: null,
          selectedText: "state.seq = patch.seq;",
          selectedTextHash: "aa11",
          contextBeforeHash: "bb22",
          contextAfterHash: "cc33",
          normalization: "lf-v1",
        },
        location: {
          headSha: sha(2),
          path: "packages/protocol/src/patch.ts",
          blobOid: oid(4),
          side: "new",
          startLine: 125,
          endLine: 129,
          status: "moved",
          version: 2,
          mappedAt: NOW,
        },
        resolution: null,
        createdAt: at("2026-09-12T08:10:00.000Z"),
        updatedAt: NOW,
      },
    ],
    approvals: [
      {
        id: id.approval("LOOM-101-a1"),
        taskId: task,
        kind: "plan",
        planVersion: 2,
        createdAt: at("2026-09-12T05:40:00.000Z"),
        voidedAt: null,
        voidReason: null,
      },
    ],
    plans: [
      {
        taskId: task,
        version: 2,
        accepted: true,
        plan: {
          goal: "A typed protocol for several windows at once",
          nonGoals: ["The WebSocket server itself"],
          steps: [{ title: "Schemas", detail: "zod, with inferred types" }],
          areas: ["packages/protocol"],
          acceptanceCriteria: ["Every schema round-trips"],
          testPlan: ["A fake client applies a patch stream"],
          risks: ["Core's types move"],
          openQuestions: [],
          suggestedImplementer: "claude",
        },
      },
    ],
    testResults: [
      {
        taskId: task,
        updatedAt: NOW,
        results: [
          {
            command: "pnpm test",
            outcome: "passed",
            summary: "492 passed",
            headSha: sha(2),
            ranAt: at("2026-09-12T08:50:00.000Z"),
            runId: id.run("LOOM-101/implementer/0"),
          },
        ],
      },
    ],
    transitions: [
      {
        id: id.transition("LOOM-101-t1"),
        taskId: task,
        at: at("2026-09-12T07:00:00.000Z"),
        from: "in_progress",
        to: "in_review",
        flags: {},
        trigger: {
          kind: "mcp",
          tool: "submit_for_review",
          runId: id.run("LOOM-101/implementer/0"),
          inputId: id.input("in-9"),
        },
        reason: "Entered in review.",
        taskVersion: 12,
      },
    ],
    threads: [
      {
        id: id.thread("LOOM-101-th1"),
        taskId: task,
        findingId: id.finding("LOOM-101-f1"),
        comments: [
          {
            id: "c1",
            author: { kind: "human", name: "you" },
            body: "Return a typed result instead of throwing.",
            at: at("2026-09-12T08:20:00.000Z"),
            editedAt: null,
            externalId: null,
          },
          {
            id: "c2",
            author: { kind: "agent", runId: id.run("LOOM-101/implementer/0") },
            body: "Done: applyPatch returns ApplyResult.",
            at: at("2026-09-12T08:40:00.000Z"),
            editedAt: null,
            externalId: null,
          },
        ],
        resolvedAt: null,
        createdAt: at("2026-09-12T08:20:00.000Z"),
        updatedAt: at("2026-09-12T08:40:00.000Z"),
      },
    ],
    reviewStates: [
      {
        taskId: task,
        headSha: sha(2),
        mode: "whole_branch",
        viewedFiles: [
          {
            fileId: id.file("f-patch"),
            path: "packages/protocol/src/patch.ts",
            headSha: sha(2),
            at: at("2026-09-12T08:30:00.000Z"),
          },
        ],
        currentFile: id.file("f-views"),
        drafts: [
          {
            id: "d1",
            threadId: id.thread("LOOM-101-th1"),
            findingId: id.finding("LOOM-101-f1"),
            fileId: null,
            body: "Half-written reply that must survive the window closing.",
            updatedAt: at("2026-09-12T08:45:00.000Z"),
          },
        ],
        updatedAt: at("2026-09-12T08:45:00.000Z"),
      },
    ],
    changes: [
      {
        id: changesKey(task, "whole_branch"),
        taskId: task,
        range: {
          mode: "whole_branch",
          baseSha: sha(1),
          headSha: sha(2),
          lastReviewedHead: null,
        },
        files: [
          {
            id: id.file("f-patch"),
            path: "packages/protocol/src/patch.ts",
            previousPath: null,
            status: "added",
            binary: false,
            added: 160,
            deleted: 0,
            version: 3,
          },
          {
            id: id.file("f-views"),
            path: "packages/protocol/src/views.ts",
            previousPath: "packages/protocol/src/derived.ts",
            status: "renamed",
            binary: false,
            added: 12,
            deleted: 4,
            version: 1,
          },
          {
            id: id.file("f-png"),
            path: "docs/design/protocol.png",
            previousPath: null,
            status: "added",
            binary: true,
            added: null,
            deleted: null,
            version: 1,
          },
        ],
        patchKey: "patch-7f3a",
        computedAt: NOW,
      },
    ],
  };
}

/**
 * The snapshot a client connecting after `stream` has been sent would receive: the finding
 * resolved, the permission answered, the question gone and the done task out of scope. Written out
 * rather than derived, so the fake-client test compares against something independent.
 */
export function after(): SnapshotBody {
  const body = snapshot();
  const task = body.tasks[0];
  const finding = body.findings[0];
  if (!task || !finding) throw new Error("sample snapshot changed");
  return {
    ...body,
    tasks: [
      {
        ...task,
        version: task.version + 1,
        attention: {
          reasons: ["stalled"],
          reasonSince: { stalled: at("2026-09-12T06:10:00.000Z") },
          since: at("2026-09-12T06:10:00.000Z"),
        },
        updatedAt: at("2026-09-12T09:05:00.000Z"),
      },
    ],
    questions: [],
    findings: [
      {
        ...finding,
        status: "resolved",
        updatedAt: at("2026-09-12T09:05:00.000Z"),
      },
    ],
  };
}

/** A patch stream that adds, changes and removes rows, for the fake client. */
export function stream(body: SnapshotBody): PatchBody[] {
  const task = body.tasks[0];
  const run = body.runs[0];
  const finding = body.findings[0];
  if (!task || !run || !finding) throw new Error("sample snapshot changed");
  const resolved = {
    ...finding,
    status: "resolved" as const,
    updatedAt: at("2026-09-12T09:05:00.000Z"),
  };
  const cleared = {
    ...task,
    version: task.version + 1,
    attention: {
      reasons: ["stalled" as const],
      reasonSince: { stalled: at("2026-09-12T06:10:00.000Z") },
      since: at("2026-09-12T06:10:00.000Z"),
    },
    updatedAt: at("2026-09-12T09:05:00.000Z"),
  };
  const changes: Change[][] = [
    [
      { op: "upsert", collection: "task", value: cleared },
      { op: "upsert", collection: "finding", value: resolved },
    ],
    [
      {
        op: "delete",
        collection: "question",
        key: id.question("LOOM-101-q1"),
        taskId: task.id,
      },
      {
        op: "delete",
        collection: "task",
        key: body.tasks[1]?.id ?? task.id,
        taskId: body.tasks[1]?.id ?? task.id,
      },
    ],
  ];
  return changes.map((entries, i) => ({
    seq: meta.seq + i + 1,
    now: at(`2026-09-12T09:0${5 + i}:00.000Z`),
    changes: entries,
  }));
}
