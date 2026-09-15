import type {
  CapacityObservation,
  DependencyObservation,
  Input,
  InputDisposition,
  TaskId,
} from "@loom/core";
import { PROVIDER_VALUES } from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { taskSchema } from "./entity-schemas.js";
import { dispositionSchema, inputSchema } from "./input-schemas.js";
import type { Outbox } from "./outbox.js";
import { dataRow } from "./records.js";
import { count, decode, positive } from "./schema-helpers.js";

export class InputStore {
  constructor(
    private readonly db: Database.Database,
    private readonly outbox: Outbox,
  ) {}
  enqueueInput(taskId: TaskId, input: Input): boolean {
    return this.outbox.enqueueInput(taskId, input);
  }
  hasInput(inputId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM inbox WHERE id = ?").get(inputId) !==
      undefined
    );
  }
  pendingInputs(taskId: TaskId, limit = 1): Input[] {
    positive.parse(limit);
    return this.db
      .prepare(
        "SELECT payload FROM inbox WHERE task_id = ? AND consumed_at IS NULL ORDER BY julianday(received_at), seq LIMIT ?",
      )
      .pluck()
      .all(taskId, limit)
      .map((v) => decode(inputSchema, v));
  }
  inputDisposition(taskId: TaskId, inputId: string): InputDisposition | null {
    const value = this.db
      .prepare("SELECT disposition FROM inbox WHERE task_id = ? AND id = ?")
      .pluck()
      .get(taskId, inputId);
    return value === undefined || value === null
      ? null
      : decode(dispositionSchema, value);
  }
  capacityCounts(): Pick<CapacityObservation, "version" | "active"> {
    return this.db.transaction(() => {
      const version = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(
          this.db
            .prepare("SELECT value FROM meta WHERE key = 'capacity_version'")
            .pluck()
            .get(),
        );
      const active = { codex: 0, claude: 0 };
      for (const raw of this.db
        .prepare(
          "SELECT provider, COUNT(*) AS count FROM runs WHERE ended_at IS NULL AND status IN ('starting', 'working', 'blocked') AND json_extract(data, '$.origin') = 'loom' GROUP BY provider",
        )
        .all()) {
        const row = z
          .object({ provider: z.enum([...PROVIDER_VALUES]), count })
          .parse(raw);
        active[row.provider] = row.count;
      }
      return { version, active };
    })();
  }
  dependencyStages(taskId: TaskId): DependencyObservation[] {
    return this.db
      .prepare(
        "SELECT t.data FROM task_dependencies d JOIN tasks t ON t.id = d.blocked_by WHERE d.task_id = ? ORDER BY t.id",
      )
      .all(taskId)
      .map((r) => {
        const task = decode(taskSchema, dataRow.parse(r).data);
        return {
          taskId: task.id,
          stage: task.stage,
          merged: task.stage === "done",
          mergeCommitSha: null,
          branch: task.branch,
        };
      });
  }
}
