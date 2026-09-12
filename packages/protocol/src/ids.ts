// The sanctioned boundary for `@loom/core`'s branded IDs: a value gets a brand here, after it is
// validated, and nowhere else. Consumers parse; they never cast (PR #18 feedback, gap 8).

import type {
  ApprovalId,
  ArtifactId,
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
import { z } from "zod";

/** Every ID is a non-empty, single-line string; the owning package decides its format. */
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !/[\n\r\t]/.test(v), "Must be a single line");

const branded = <B>() => id.transform((v) => v as unknown as B);

export const repoId = branded<RepoId>();
export const taskId = branded<TaskId>();
export const runId = branded<RunId>();
export const artifactId = branded<ArtifactId>();
export const findingId = branded<FindingId>();
export const approvalId = branded<ApprovalId>();
export const questionId = branded<QuestionId>();
export const messageId = branded<MessageId>();
export const transitionId = branded<TransitionId>();
export const inputId = branded<InputId>();
export const providerSessionId = branded<ProviderSessionId>();

/**
 * A canonical realpath, so the join key compares equal: macOS reports the same folder as both
 * `/var/…` and `/private/var/…`, and a `..` left in the path joins nothing (principle 6).
 */
export const worktreePath = id
  .refine((v) => v.startsWith("/"), "Must be an absolute path")
  .refine(
    (v) =>
      !v.endsWith("/") &&
      !v
        .split("/")
        .some(
          (part, i) => part === "." || part === ".." || (i > 0 && part === ""),
        ),
    "Must be canonical: no `.`, `..` or empty segments",
  )
  .transform((v) => v as WorktreePath);

const hex40 = z.string().regex(/^[0-9a-f]{40}$/);
export const sha = hex40.transform((v) => v as Sha);
export const blobOid = hex40.transform((v) => v as BlobOid);

/** ISO-8601 UTC, as core stores it and the other packages validate it. */
export const isoTime = z.iso.datetime().transform((v) => v as IsoTime);

/** Coordinator-owned keys that `@loom/core` has no brand for. */
export const threadId = z.string().min(1).max(512);
export const draftId = z.string().min(1).max(512);
/** Pierre's per-file key: stable while the file is the same file, across heads. */
export const fileId = z.string().min(1).max(512);
/** A client's own request key; echoed in the acknowledgement. */
export const requestId = z.string().min(1).max(128);
/** A window or CLI instance. One coordinator serves many at once. */
export const clientId = z.string().min(1).max(128);

export const count = z.number().int().nonnegative();
export const seq = z.number().int().positive();
export const line = z.number().int().positive();
export const text = z.string();
export const path = z
  .string()
  .min(1)
  .refine(
    (v) => !v.startsWith("/") && !v.split("/").includes(".."),
    "Use a repository-relative path",
  );
