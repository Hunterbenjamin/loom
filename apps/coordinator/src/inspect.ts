// Offline diagnostics read coordinator-owned records; no provider observation or reconciliation.
import { stripVTControlCharacters } from "node:util";
import type { FindingStatus, TaskId } from "@loom/core";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";

export function inspectTask(store: Store, taskId: TaskId, adapters?: Adapters) {
  const state = store.loadTaskState(taskId);
  const task = state.task;
  const runs = store.runs(taskId);
  const messages = store.messages(taskId);
  const counts: Record<FindingStatus, number> = {
    open: 0,
    addressed: 0,
    disputed: 0,
    resolved: 0,
    fixed: 0,
    escalate: 0,
    waived: 0,
  };
  for (const finding of state.findings) counts[finding.status]++;
  // Check if the task has a running Codex app-server (only possible if adapters are provided)
  // A server can only be running if the task is not in a terminal stage AND the adapter exists
  const codexServerRunning = !!(
    adapters && !["done", "canceled"].includes(task.stage)
  );

  return {
    notes: store.operator.notes(taskId),
    reviewHistory: state.findings,
    task: {
      signature: store.operator.signature(taskId),
      id: task.id,
      title: task.title,
      stage: task.stage,
      stageEnteredAt: task.stageEnteredAt,
      attention: task.attention,
      blocked: task.blocked,
      failed: task.failed,
      reviewRound: task.reviewRound,
      branch: task.branch,
      prNumber: task.prNumber,
      worktreePath: task.worktreePath,
      codexServerRunning,
    },
    runs: runs.map((run) => ({
      id: run.id,
      role: run.role,
      provider: run.provider,
      mode: run.mode,
      status: run.status,
      blockedOn: run.blockedOn,
      sessionEpoch: run.sessionEpoch,
      attempts: run.attempts,
      sessionId: run.sessionId,
      retryAt: run.retryAt,
      unknownSince: run.unknownSince ?? null,
      lastTurn: run.lastTurn,
      pendingRequests: run.pendingRequests.length,
      requests: run.pendingRequests,
      pendingDialog: run.pendingDialog ?? null,
      endedAt: run.endedAt,
      endReason: run.endReason,
    })),
    messages: runs.map((run) => ({
      runId: run.id,
      messages: messages
        .filter((m) => m.runId === run.id)
        .map((m) => ({
          kind: m.purpose,
          status: m.status,
          attempts: m.attempts,
          deliveredAt: m.delivered?.at ?? null,
          text: [...m.text].slice(0, 80).join(""),
        })),
    })),
    questions: state.questions,
    // Stored Approval rows are grants, not requests awaiting a decision.
    pendingApprovals: [
      ...(task.stage === "plan_approval"
        ? [{ kind: "plan", planVersion: state.plan?.version ?? null }]
        : []),
      ...(task.stage === "awaiting_approval"
        ? [{ kind: "merge", headSha: state.worktree?.git?.headSha ?? null }]
        : []),
      ...runs
        .filter((run) => run.endedAt === null)
        .flatMap((run) =>
          run.pendingRequests
            .filter((request) => request.kind !== "question")
            .map((request) => ({ runId: run.id, ...request })),
        ),
    ],
    outbox: store.outbox.recent(taskId),
    findings: {
      counts,
      open: state.findings
        .filter((f) => f.status === "open")
        .map((f) => ({
          title: f.title,
          location: f.location
            ? {
                path: f.location.path,
                startLine: f.location.startLine,
                endLine: f.location.endLine,
                side: f.location.side,
                status: f.location.status,
              }
            : f.anchor
              ? {
                  path:
                    f.anchor.side === "new"
                      ? f.anchor.newPath
                      : f.anchor.oldPath,
                  startLine: f.anchor.startLine,
                  endLine: f.anchor.endLine,
                  side: f.anchor.side,
                  status: "original",
                }
              : null,
        })),
    },
  };
}

type Inspection = ReturnType<typeof inspectTask>;
const oneLine = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? "-"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return stripVTControlCharacters(text).replace(/[\r\n\t]/g, (c) =>
    c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t",
  );
};

export function formatInspection(data: Inspection): string {
  const lines: string[] = [];
  const facts = (record: object) => {
    for (const [key, value] of Object.entries(record))
      lines.push(`  ${`${key}:`.padEnd(23)} ${oneLine(value)}`);
  };
  lines.push("Task");
  const taskDisplay = { ...data.task };
  facts(taskDisplay);
  lines.push("", `Runs (${data.runs.length}, newest last)`);
  for (const run of data.runs) {
    facts(run);
    lines.push("");
  }
  lines.push("Messages");
  for (const group of data.messages) {
    facts({ runId: group.runId });
    if (!group.messages.length) lines.push("  (none)");
    for (const message of group.messages) {
      facts(message);
      lines.push("");
    }
  }
  if (data.questions.length) {
    lines.push("", "Open questions");
    for (const question of data.questions) {
      facts(question);
      lines.push("");
    }
  }
  if (data.pendingApprovals.length) {
    lines.push("", "Pending approvals");
    for (const approval of data.pendingApprovals) {
      facts(approval);
      lines.push("");
    }
  }
  lines.push("", `Outbox (${data.outbox.length}, newest last)`);
  for (const row of data.outbox) {
    facts(row);
    lines.push("");
  }
  if (data.notes.length) {
    lines.push("", "Notes");
    for (const note of data.notes) facts(note);
  }
  lines.push("Findings");
  facts(data.findings.counts);
  for (const finding of data.findings.open) {
    lines.push("");
    facts(finding);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function getTaskTimings(store: Store, taskId: TaskId) {
  const transitions = store.transitions(taskId);
  if (transitions.length === 0) {
    return {
      stageTimings: [],
      totalDuration: null,
      message: "No transitions found",
    };
  }

  const stageTimings: Array<{
    from: string;
    to: string;
    duration: number;
    at: string;
  }> = [];

  for (const transition of transitions) {
    const duration = new Date(transition.at).getTime();
    const prevTime =
      transitions.indexOf(transition) > 0
        ? new Date(
            transitions[transitions.indexOf(transition) - 1]?.at ?? "",
          ).getTime()
        : duration;

    const durationMs = duration - prevTime;

    stageTimings.push({
      from: transition.from,
      to: transition.to,
      duration: durationMs,
      at: transition.at,
    });
  }

  const startTime = new Date(transitions[0]?.at ?? "").getTime();
  const endTime = new Date(
    transitions[transitions.length - 1]?.at ?? "",
  ).getTime();
  const totalDuration = endTime - startTime;

  return { stageTimings, totalDuration };
}
