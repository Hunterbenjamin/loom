import { StaleCodexRequestError } from "@loom/adapter-codex";
import { BaseMergePreconditionError } from "@loom/adapter-git";
import { GitHubError } from "@loom/adapter-github";
import type { ActionError } from "@loom/core";

/** The world moved on: re-read and decide again. Never a retry of the same intent. */
export class PreconditionFailed extends Error {}
/** Don't retry; the task is flagged failed. */
export class Fatal extends Error {}

export const classify = (error: unknown): ActionError => {
  if (error instanceof GitHubError)
    return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof PreconditionFailed ||
    error instanceof BaseMergePreconditionError ||
    error instanceof StaleCodexRequestError
  )
    return { code: "precondition", message };
  if (error instanceof Fatal) return { code: "fatal", message };
  return { code: "retryable", message };
};
