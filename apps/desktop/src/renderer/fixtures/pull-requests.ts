import type { Repo, Task } from "@loom/core";
import type { PullRequestRow } from "@loom/protocol";
import { minutesBefore, sha } from "./ids.js";

export function buildPullRequests(
  repos: Repo[],
  tasks: Task[],
): PullRequestRow[] {
  return repos.flatMap((repo) =>
    Array.from({ length: 6 }, (_, index): PullRequestRow => {
      const task = tasks.find((task) => task.repoId === repo.id && task.branch);
      const linked = index === 0 ? task : undefined;
      return {
        repoId: repo.id,
        number: 201 + index,
        title:
          linked?.title ??
          [
            "",
            "Improve keyboard navigation",
            "Handle conflicting changes",
            "Update documentation",
            "Simplify repository setup",
            "Retire an old experiment",
          ][index] ??
          "Pull request",
        taskId: linked?.id ?? null,
        head: linked?.branch ?? `feat/example-${index}`,
        base: "main",
        headSha: sha(index + 1),
        author: index === 3 ? null : "fixture-contributor",
        state: index === 4 ? "merged" : index === 5 ? "closed" : "open",
        draft: index === 3,
        mergeable:
          index === 2 ? "conflicting" : index === 3 ? "unknown" : "mergeable",
        checks:
          (
            [
              "success",
              "pending",
              "failure",
              "none",
              "success",
              "none",
            ] as const
          )[index] ?? "none",
        review:
          index === 0 ? "approved" : index === 2 ? "changes_requested" : "none",
        createdAt: minutesBefore(30 + index * 180),
        updatedAt: minutesBefore(index * 10),
        observedAt: minutesBefore(0),
        url: `https://github.com/${repo.github}/pull/${201 + index}`,
      };
    }),
  );
}

/** Detail fixtures remain read-only; actions still require a coordinator. */
export function buildPullRequestDetails(rows: PullRequestRow[]) {
  return rows.map((row): import("@loom/protocol").PullRequestDetailRow => ({
    repoId: row.repoId,
    number: row.number,
    taskId: row.taskId,
    detail: {
      ...(({ repoId: _repo, taskId: _task, ...summary }) => summary)(row),
      branchExists: row.state !== "closed",
      body: `## Summary\n\n${row.title}\n\n- Renders **Markdown** and \`code\`.\n- Keeps GitHub as the owner.\n\n### Validation\n\n\`pnpm test\``,
      mergedAt: row.state === "merged" ? row.updatedAt : null,
      mergeCommitSha: row.state === "merged" ? sha(90) : null,
      commits: [
        {
          sha: row.headSha,
          message: row.title,
          author: row.author,
          committedAt: row.createdAt,
          url: row.url.replace(/pull\/\d+$/, `commit/${row.headSha}`),
        },
      ],
      checkRuns:
        row.checks === "none"
          ? []
          : [
              {
                id: "fixture-check",
                name: "test",
                status: row.checks === "pending" ? "in_progress" : "completed",
                conclusion: row.checks === "pending" ? null : row.checks,
                url: row.url,
                startedAt: minutesBefore(5),
                completedAt: row.checks === "pending" ? null : minutesBefore(3),
              },
            ],
      additions: 1,
      deletions: 1,
      changedFiles: 1,
    },
    patch: {
      patch: `diff --git a/example.ts b/example.ts\nindex 1234567..abcdef0 100644\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = ${row.number};\n`,
      truncated: false,
      observedAt: row.observedAt,
    },
  }));
}
