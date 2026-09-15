import type { Repo } from "@loom/core";
import type Database from "better-sqlite3";
import { repoSchema } from "./entity-schemas.js";
import { dataRow, encodedUpdate } from "./records.js";
import { decode } from "./schema-helpers.js";

export class RepositoryStore {
  constructor(private readonly db: Database.Database) {}
  /** Coordinator-owned per-instance project selection, persisted in the existing metadata table. */
  selectedRepo(): Repo["id"] | null {
    const saved = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_opened_repo'")
      .pluck()
      .get();
    const repos = this.repos();
    return repos.find((repo) => repo.id === saved)?.id ?? repos[0]?.id ?? null;
  }
  selectRepo(id: string): void {
    if (!this.repos().some((repo) => repo.id === id))
      throw new Error("Unknown registered repository");
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES ('last_opened_repo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(id);
  }
  putRepo(repo: Repo): void {
    const value = repoSchema.parse(repo);
    this.db
      .transaction(() => {
        const raw = this.db
          .prepare("SELECT data FROM repos WHERE id = ?")
          .get(value.id);
        this.db
          .prepare(
            "INSERT INTO repos(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
          )
          .run(
            value.id,
            encodedUpdate(
              repoSchema,
              raw === undefined ? undefined : dataRow.parse(raw).data,
              value,
            ),
          );
      })
      .immediate();
  }
  /** Every registered repo. The coordinator's snapshot needs the list, and nothing else owns it. */
  repos(): Repo[] {
    return this.db
      .prepare("SELECT data FROM repos ORDER BY rowid")
      .all()
      .map((r) => decode(repoSchema, dataRow.parse(r).data));
  }
}
