import type { TaskId } from "@loom/core";
import { pullRequestReviewChange, viewedFile } from "@loom/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { RepositoryStore } from "./repositories.js";
import type { TaskQueries } from "./task-queries.js";

export class PullRequestStore {
  constructor(
    private readonly db: Database.Database,
    private readonly repositories: RepositoryStore,
    private readonly queries: TaskQueries,
  ) {}
  /** PR preferences are Loom facts; GitHub content remains a disposable projection. */
  pullRequestPreferences(
    repoId: string,
    number: number,
  ): { pinned: boolean; taskId: TaskId | null } {
    const raw = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .pluck()
      .get(`pr:${JSON.stringify([repoId, number])}`);
    return raw === undefined
      ? { pinned: false, taskId: null }
      : z
          .object({
            pinned: z.boolean(),
            taskId: z
              .string()
              .min(1)
              .transform((value) => value as TaskId)
              .nullable(),
          })
          .parse(JSON.parse(z.string().parse(raw)));
  }
  setPullRequestPreferences(
    repoId: string,
    number: number,
    update: { pinned?: boolean; taskId?: TaskId },
  ): void {
    if (!this.repositories.repos().some((repo) => repo.id === repoId))
      throw new Error("Unknown registered repository");
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Invalid pull request number");
    if (
      update.taskId &&
      !this.queries
        .tasks()
        .some((task) => task.id === update.taskId && task.repoId === repoId)
    )
      throw new Error("Issue must belong to the pull request repository");
    const value = { ...this.pullRequestPreferences(repoId, number), ...update };
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(`pr:${JSON.stringify([repoId, number])}`, JSON.stringify(value));
  }
  /** Reverse projection of the same durable links, independent of GitHub cache/subscriptions. */
  linkedPullRequests(repoId: string, taskId: TaskId): number[] {
    const keys = this.db
      .prepare(
        "SELECT key FROM meta WHERE key LIKE 'pr:%' AND json_extract(value, '$.taskId') = ?",
      )
      .pluck()
      .all(taskId);
    return keys
      .flatMap((key) => {
        const [repo, number] = z
          .tuple([z.string(), z.number().int().positive()])
          .parse(JSON.parse(z.string().parse(key).slice(3)));
        return repo === repoId ? [number] : [];
      })
      .sort((a, b) => a - b);
  }
  pullRequestViewedFiles(repoId: string, number: number, headSha: string) {
    const raw = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .pluck()
      .get(`pr-viewed:${JSON.stringify([repoId, number])}`);
    if (raw === undefined) return [];
    const saved = z
      .object({ headSha: z.string(), files: z.array(viewedFile) })
      .parse(JSON.parse(z.string().parse(raw)));
    return saved.headSha === headSha ? saved.files : [];
  }
  savePullRequestReviewState(
    command: z.output<typeof pullRequestReviewChange>,
  ): void {
    const { repoId, number, change } = pullRequestReviewChange.parse(command);
    if (!this.repositories.repos().some((repo) => repo.id === repoId))
      throw new Error("Unknown registered repository");
    const files = new Map(
      this.pullRequestViewedFiles(repoId, number, change.headSha).map(
        (file) => [file.fileId, file],
      ),
    );
    for (const file of change.viewed ?? []) {
      if (file.headSha !== change.headSha)
        throw new Error("Viewed file head must match review head");
      files.set(file.fileId, file);
    }
    for (const id of change.unviewed ?? []) files.delete(id);
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(
        `pr-viewed:${JSON.stringify([repoId, number])}`,
        JSON.stringify({ headSha: change.headSha, files: [...files.values()] }),
      );
  }
}
