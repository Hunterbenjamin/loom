import type { CiState, IsoTime, Sha } from "@loom/core";
import type { Api } from "./api.js";
import { GitHubError } from "./gh.js";
import * as s from "./schemas.js";

export async function readCi(
  api: Api,
  repo: string,
  headSha: Sha,
  now: IsoTime,
) {
  const root = `repos/${repo}`;
  const [rawChecks, { value: combined }] = await Promise.all([
    api.all(
      `${root}/commits/${headSha}/check-runs?per_page=100&filter=latest`,
      s.checks.transform((v) => v.check_runs),
    ),
    api.get(`${root}/commits/${headSha}/status`, s.statuses),
  ]);
  if (
    combined.sha !== headSha ||
    rawChecks.some((check) => check.head_sha !== headSha)
  )
    throw new GitHubError("retryable", "GitHub CI head changed during read");
  const checks = rawChecks.map((check) => ({
    id: String(check.id),
    name: check.name,
    status:
      check.status === "completed" || check.status === "in_progress"
        ? check.status
        : ("queued" as const),
    conclusion: check.conclusion,
    url: check.html_url,
    startedAt: check.started_at ?? null,
    completedAt: check.completed_at ?? null,
  }));
  const failed = checks.some(
    (check) =>
      check.status === "completed" &&
      check.conclusion !== null &&
      !["success", "neutral", "skipped"].includes(check.conclusion),
  );
  const pending = checks.some(
    (check) => check.status !== "completed" || check.conclusion === null,
  );
  const conclusion =
    failed || (combined.total_count > 0 && combined.state === "failure")
      ? "failure"
      : pending || (combined.total_count > 0 && combined.state === "pending")
        ? "pending"
        : checks.length > 0 || combined.total_count > 0
          ? "success"
          : "none";
  return { headSha, conclusion, checks, observedAt: now } satisfies CiState;
}
