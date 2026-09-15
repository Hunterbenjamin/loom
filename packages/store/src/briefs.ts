import {
  type BriefRun,
  type BriefState,
  briefRun,
  briefSchedule,
} from "@loom/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";

/** Instance-wide research jobs. Each record is durable independently of UI connections. */
export class BriefStore {
  constructor(private readonly db: Database.Database) {}
  private read(key: string): unknown {
    const raw = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .pluck()
      .get(key);
    return raw === undefined ? undefined : JSON.parse(z.string().parse(raw));
  }
  private write(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  schedule(): BriefState["schedule"] {
    return briefSchedule.parse(
      this.read("brief:schedule") ?? {
        enabled: true,
        hour: 7,
        timeZone: "Asia/Makassar",
      },
    );
  }
  setEnabled(enabled: boolean): void {
    this.write(
      "brief:schedule",
      briefSchedule.parse({ ...this.schedule(), enabled }),
    );
  }
  get(id: string): BriefRun | null {
    const value = this.read(`brief:run:${id}`);
    return value === undefined ? null : briefRun.parse(value);
  }
  put(run: BriefRun): void {
    this.write(`brief:run:${run.id}`, briefRun.parse(run));
  }
  list(): BriefRun[] {
    return this.db
      .prepare(
        "SELECT value FROM meta WHERE key LIKE 'brief:run:%' ORDER BY json_extract(value, '$.startedAt') DESC, key DESC LIMIT 30",
      )
      .pluck()
      .all()
      .map((raw) => briefRun.parse(JSON.parse(z.string().parse(raw))));
  }
  hasScheduledDate(date: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM meta WHERE key LIKE 'brief:run:%' AND json_extract(value, '$.scheduledDate')=? LIMIT 1",
        )
        .get(date) !== undefined
    );
  }
  state(): BriefState {
    return {
      schedule: this.schedule(),
      runs: this.list().map(({ content, ...run }) => ({
        ...run,
        headline: content?.headline ?? null,
      })),
    };
  }
}
