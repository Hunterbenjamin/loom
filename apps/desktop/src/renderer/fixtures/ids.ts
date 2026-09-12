// `@loom/core` brands its IDs so nothing downstream can invent one. Real code gets branded
// values from a zod boundary; the fixture store is that boundary here.
import type {
  ApprovalId,
  BlobOid,
  FindingId,
  InputId,
  IsoTime,
  MessageId,
  ProviderSessionId,
  QuestionId,
  RepoId,
  RunId,
  Sha,
  TaskId,
  TransitionId,
  WorktreePath,
} from "@loom/core";

export const repoId = (value: string) => value as RepoId;
export const taskId = (value: string) => value as TaskId;
export const runId = (value: string) => value as RunId;
export const findingId = (value: string) => value as FindingId;
export const approvalId = (value: string) => value as ApprovalId;
export const questionId = (value: string) => value as QuestionId;
export const messageId = (value: string) => value as MessageId;
export const transitionId = (value: string) => value as TransitionId;
export const inputId = (value: string) => value as InputId;
export const sessionId = (value: string) => value as ProviderSessionId;
export const worktreePath = (value: string) => value as WorktreePath;
export const isoTime = (value: string) => value as IsoTime;

export function blobOid(seed: number): BlobOid {
  return sha(seed) as string as BlobOid;
}

export function sha(seed: number): Sha {
  let out = "";
  let a = seed >>> 0;
  while (out.length < 40) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    out += a.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40) as Sha;
}

/** The fixture's clock. Ages are relative to this, so screenshots and measurements repeat. */
export const NOW = isoTime("2026-09-12T09:00:00.000Z");

export function minutesBefore(minutes: number): IsoTime {
  return isoTime(new Date(Date.parse(NOW) - minutes * 60_000).toISOString());
}
