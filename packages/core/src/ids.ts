// Nominal string types. The boundary (zod, in the packages that do I/O) validates a value
// before it gets one of these brands; core never parses raw strings.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RepoId = Brand<string, "RepoId">;
export type TaskId = Brand<string, "TaskId">;
/** Deterministic: `${taskId}/${role}/${round}/${attempt}`. See docs/design/core.md, "IDs". */
export type RunId = Brand<string, "RunId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type FindingId = Brand<string, "FindingId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type QuestionId = Brand<string, "QuestionId">;
export type MessageId = Brand<string, "MessageId">;
export type TransitionId = Brand<string, "TransitionId">;
/** Assigned when an input (human command, MCP call, action result) is persisted. */
export type InputId = Brand<string, "InputId">;
/** Deterministic idempotency key for an action. Same intent, same key. */
export type ActionKey = Brand<string, "ActionKey">;

/** Canonical `realpath` of a worktree: the join key (principle 6). */
export type WorktreePath = Brand<string, "WorktreePath">;
/** Full 40-hex commit SHA. */
export type Sha = Brand<string, "Sha">;
/** Git blob object ID. */
export type BlobOid = Brand<string, "BlobOid">;
/** Claude session UUID or Codex thread ID. Recorded before the first prompt (principle 7). */
export type ProviderSessionId = Brand<string, "ProviderSessionId">;

/** ISO-8601 UTC timestamp. */
export type IsoTime = Brand<string, "IsoTime">;
