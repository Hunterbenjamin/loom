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
