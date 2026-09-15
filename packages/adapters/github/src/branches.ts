import {
  failure,
  type GhRunner,
  GitHubError,
  json,
  parse,
  response,
} from "./gh.js";
import * as s from "./schemas.js";

/** REST-only: gh pr merge --delete-branch can also manipulate the local checkout. */
export function branchActions(run: GhRunner) {
  return async (repo: string, branch: string): Promise<void> => {
    s.repo.parse(repo);
    s.remoteBranch.parse(branch);
    // DELETE is authoritative even for an absent branch: a GET 404 can also hide permissions.
    let error: unknown;
    try {
      const raw = await run([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "DELETE",
        "--include",
        `repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      ]);
      const result = response(raw, [204, 422]);
      if (
        result.status === 422 &&
        parse(s.apiError, json(result.body)).message.toLowerCase() !==
          "reference does not exist"
      )
        throw failure(raw, 422, result.headers);
    } catch (caught) {
      error = caught;
    }
    // Never turn authorization/validation errors into successful deletion based on a hidden 404.
    if (error instanceof GitHubError && error.code !== "retryable") throw error;
    if (!(await branchExists(run, repo, branch))) return;
    if (error) throw error;
    throw new GitHubError(
      "retryable",
      "GitHub branch deletion is not yet observable",
    );
  };
}

async function branchExists(run: GhRunner, repo: string, branch: string) {
  const result = response(
    await run([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    ]),
    [200, 404],
  );
  if (result.status === 404) {
    parse(s.apiError, json(result.body));
    return false;
  }
  const ref = parse(s.ref, json(result.body));
  if (ref.ref !== `refs/heads/${branch}`)
    throw new GitHubError("fatal", "GitHub returned a different branch");
  return true;
}
