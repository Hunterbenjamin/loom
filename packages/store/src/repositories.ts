import type { Repo } from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { repoSchema } from "./entity-schemas.js";
import { dataRow, encodedUpdate } from "./records.js";
import { decode } from "./schema-helpers.js";
import type { SettingsStore } from "./settings.js";

export class RepositoryStore {
  constructor(
    private readonly db: Database.Database,
    private readonly settings: SettingsStore,
  ) {}
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
  /** Legacy repository settings are read raw because Repo no longer owns these fields. */
  legacyRepoSettings(): Array<{
    repo: Repo;
    baseBranch?: string;
    defaultProviders?: Partial<
      Record<"planner" | "implementer" | "reviewer", "codex" | "claude">
    >;
    serialTests?: boolean;
  }> {
    return this.db
      .prepare("SELECT data FROM repos ORDER BY rowid")
      .all()
      .map((row) => {
        const raw = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(dataRow.parse(row).data));
        const repo = repoSchema.parse(raw);
        return {
          repo,
          ...(typeof raw.baseBranch === "string"
            ? { baseBranch: raw.baseBranch }
            : {}),
          ...(raw.defaultProviders && typeof raw.defaultProviders === "object"
            ? {
                defaultProviders: z
                  .partialRecord(
                    z.enum(["planner", "implementer", "reviewer"]),
                    z.enum(["codex", "claude"]),
                  )
                  .parse(raw.defaultProviders),
              }
            : {}),
          ...(typeof raw.serialTests === "boolean"
            ? { serialTests: raw.serialTests }
            : {}),
        };
      })
      .filter(
        (value) =>
          value.baseBranch !== undefined ||
          value.defaultProviders !== undefined ||
          value.serialTests !== undefined,
      );
  }
  /** Move legacy settings and remove their old owners as one durable operation. */
  migrateLegacySettings(
    globalUpdate: Parameters<SettingsStore["update"]>[0] | undefined,
    repositories: Array<{
      repoId: Repo["id"];
      update?: Parameters<SettingsStore["update"]>[0];
    }>,
  ): void {
    this.db
      .transaction(() => {
        if (globalUpdate) this.settings.update(globalUpdate);
        for (const { repoId, update } of repositories) {
          if (update) this.settings.update(update);
          const row = dataRow.parse(
            this.db.prepare("SELECT data FROM repos WHERE id = ?").get(repoId),
          );
          const raw = z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(row.data));
          delete raw.baseBranch;
          delete raw.defaultProviders;
          delete raw.serialTests;
          this.db
            .prepare("UPDATE repos SET data = ? WHERE id = ?")
            .run(JSON.stringify(raw), repoId);
        }
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
