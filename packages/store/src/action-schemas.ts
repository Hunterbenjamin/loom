import type { Action, ActionResult, OutboxEntry } from "@loom/core";
import { z } from "zod";
import { locationSchema } from "./entity-schemas.js";
import {
  artifactKind,
  contract,
  count,
  errorSchema,
  id,
  paneRef,
  positive,
  provider,
  role,
  sendVia,
  sha,
  text,
  time,
} from "./schema-helpers.js";

const fields = {
  create_worktree: { repoId: id, path: text, branch: text, baseBranch: text },
  write_task_files: {
    worktreePath: text,
    artifacts: z.array(z.object({ kind: artifactKind, version: positive })),
  },
  open_workspace: { worktreePath: text, label: text },
  start_run: {
    runId: id,
    role,
    provider,
    mode: z.enum(["headless", "interactive"]),
    worktreePath: text,
    model: text,
    attempt: positive,
    sessionEpoch: count,
    sessionId: id.nullable(),
    resume: z.boolean(),
  },
  send_message: {
    runId: id,
    messageId: id,
    via: sendVia,
    text,
    expectedTurnId: text.nullable(),
  },
  interrupt_run: { runId: id, reason: text },
  answer_provider_request: {
    runId: id,
    requestId: id,
    generation: count.nullable(),
    decision: z.enum(["accept", "decline", "cancel"]),
    answers: z.record(text, z.array(text)).nullable(),
  },
  stop_run: { runId: id },
  push_branch: { worktreePath: text, branch: text, expectedHeadSha: sha },
  open_pr: {
    repoId: id,
    branch: text,
    baseBranch: text,
    title: text,
    body: text,
  },
  merge_pr: {
    repoId: id,
    prNumber: positive,
    matchHeadSha: sha,
    auto: z.boolean(),
  },
  map_findings: { worktreePath: text, toHeadSha: sha, findingIds: z.array(id) },
  disable_auto_merge: { repoId: id, prNumber: positive },
  refresh: {
    owner: z.enum(["git", "github", "codex_rate_limits", "claude_agents"]),
  },
  schedule: {
    at: time,
    why: z.enum([
      "retry",
      "stall_check",
      "cooldown_end",
      "poll",
      "delivery_timeout",
    ]),
  },
  notify: { level: z.enum(["info", "attention"]), title: text, body: text },
  answer_pane_prompt: {
    runId: id,
    choice: z.union([
      z.number().int().min(0).max(9),
      z.enum(["enter", "escape"]),
    ]),
    text: text.optional(),
  },
} as const;
export const actionKind = z.enum(
  Object.keys(fields) as [keyof typeof fields, ...(keyof typeof fields)[]],
);
// Validate the discriminant first, then every field for that action. Preserve forward additive fields.
export const actionSchema = contract<Action>()(
  z.discriminatedUnion("kind", [
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("create_worktree"),
      ...fields.create_worktree,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("write_task_files"),
      ...fields.write_task_files,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("open_workspace"),
      ...fields.open_workspace,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("start_run"),
      ...fields.start_run,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("send_message"),
      ...fields.send_message,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("interrupt_run"),
      ...fields.interrupt_run,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("answer_provider_request"),
      ...fields.answer_provider_request,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("stop_run"),
      ...fields.stop_run,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("push_branch"),
      ...fields.push_branch,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("open_pr"),
      ...fields.open_pr,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("merge_pr"),
      ...fields.merge_pr,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("map_findings"),
      ...fields.map_findings,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("disable_auto_merge"),
      ...fields.disable_auto_merge,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("refresh"),
      ...fields.refresh,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("schedule"),
      ...fields.schedule,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("notify"),
      ...fields.notify,
    }),
    z.object({
      key: id,
      taskId: id,
      kind: z.literal("answer_pane_prompt"),
      ...fields.answer_pane_prompt,
    }),
  ]),
);
const empty = z.object({});
const outputs = {
  create_worktree: z.object({ path: text, headSha: sha, baseSha: sha }),
  write_task_files: empty,
  open_workspace: z.object({ workspaceId: text }),
  start_run: z.object({
    sessionId: id,
    codexGeneration: count.nullable(),
    pane: paneRef.nullable(),
  }),
  send_message: z.object({ transportRef: text.nullable() }),
  interrupt_run: empty,
  answer_provider_request: empty,
  stop_run: empty,
  push_branch: z.object({ remoteHeadSha: sha }),
  open_pr: z.object({ number: positive, url: text }),
  merge_pr: z.object({ state: z.enum(["merged", "auto_merge_enabled"]) }),
  map_findings: z.object({
    locations: z.array(z.object({ findingId: id, location: locationSchema })),
  }),
  disable_auto_merge: empty,
  refresh: empty,
  schedule: empty,
  notify: empty,
  answer_pane_prompt: empty,
} as const;
export const actionResultSchema = contract<ActionResult>()(
  z.union([
    z.object({
      kind: z.literal("create_worktree"),
      ok: z.literal(true),
      output: outputs.create_worktree,
    }),
    z.object({
      kind: z.literal("write_task_files"),
      ok: z.literal(true),
      output: outputs.write_task_files,
    }),
    z.object({
      kind: z.literal("open_workspace"),
      ok: z.literal(true),
      output: outputs.open_workspace,
    }),
    z.object({
      kind: z.literal("start_run"),
      ok: z.literal(true),
      output: outputs.start_run,
    }),
    z.object({
      kind: z.literal("send_message"),
      ok: z.literal(true),
      output: outputs.send_message,
    }),
    z.object({
      kind: z.literal("interrupt_run"),
      ok: z.literal(true),
      output: outputs.interrupt_run,
    }),
    z.object({
      kind: z.literal("answer_provider_request"),
      ok: z.literal(true),
      output: outputs.answer_provider_request,
    }),
    z.object({
      kind: z.literal("stop_run"),
      ok: z.literal(true),
      output: outputs.stop_run,
    }),
    z.object({
      kind: z.literal("push_branch"),
      ok: z.literal(true),
      output: outputs.push_branch,
    }),
    z.object({
      kind: z.literal("open_pr"),
      ok: z.literal(true),
      output: outputs.open_pr,
    }),
    z.object({
      kind: z.literal("merge_pr"),
      ok: z.literal(true),
      output: outputs.merge_pr,
    }),
    z.object({
      kind: z.literal("map_findings"),
      ok: z.literal(true),
      output: outputs.map_findings,
    }),
    z.object({
      kind: z.literal("disable_auto_merge"),
      ok: z.literal(true),
      output: outputs.disable_auto_merge,
    }),
    z.object({
      kind: z.literal("refresh"),
      ok: z.literal(true),
      output: outputs.refresh,
    }),
    z.object({
      kind: z.literal("schedule"),
      ok: z.literal(true),
      output: outputs.schedule,
    }),
    z.object({
      kind: z.literal("notify"),
      ok: z.literal(true),
      output: outputs.notify,
    }),
    z.object({
      kind: z.literal("answer_pane_prompt"),
      ok: z.literal(true),
      output: outputs.answer_pane_prompt,
    }),
    z.object({ kind: actionKind, ok: z.literal(false), error: errorSchema }),
  ]),
);
export const outboxSchema = contract<OutboxEntry>()(
  z.object({
    key: id,
    kind: actionKind,
    status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
    attempts: count,
    createdAt: time,
    finishedAt: time.nullable(),
    action: actionSchema.optional(),
    retryAt: time.optional(),
    dependsOn: z.array(id).optional(),
    retriedBy: id.optional(),
    retryBaseAttempt: count.optional(),
    error: errorSchema.optional(),
  }),
);
