import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IsoTime, ReconcileConfig } from "@loom/core";
import Database from "better-sqlite3";
import { z } from "zod";
import { migrate } from "./migrations.js";
import { Store } from "./store.js";

export { SqliteHookLog } from "./hooks.js";
export * from "./operator.js";
export type { ClaimedAction, RunningAction } from "./outbox.js";
export type { CommitOutcome, Conflict } from "./store.js";
export { Store } from "./store.js";
export interface StoreOptions {
  /** Explicit parent of instance directories; never implicitly reaches the installed coordinator. */
  dataRoot: string;
  /** Defaults to LOOM_INSTANCE; absence is an error. Development callers use dev. */
  instance?: string;
  config: ReconcileConfig;
  now?: IsoTime;
}
/** Diagnostics only: no creation, migrations, hook pruning or artifact repair. */
export function openReadOnlyStore(options: StoreOptions): Store {
  const instance = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .parse(options.instance ?? process.env.LOOM_INSTANCE);
  const root = realpathSync(resolve(z.string().min(1).parse(options.dataRoot)));
  const dataDirectory = join(root, instance);
  if (realpathSync(dataDirectory) !== dataDirectory)
    throw new Error("Instance directory must not be a symlink");
  const db = new Database(join(dataDirectory, "loom.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  return new Store(db, dataDirectory, options.config);
}
export async function openStore(options: StoreOptions): Promise<
  Store & {
    startupRunning: ReturnType<Store["outbox"]["runningAtStartup"]>;
    migrationBackups: string[];
  }
> {
  const instance = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .parse(options.instance ?? process.env.LOOM_INSTANCE);
  const root = resolve(z.string().min(1).parse(options.dataRoot));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = realpathSync(root);
  const dataDirectory = join(canonicalRoot, instance);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  if (realpathSync(dataDirectory) !== dataDirectory)
    throw new Error("Instance directory must not be a symlink");
  const db = new Database(join(dataDirectory, "loom.sqlite"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = FULL");
    const migrationBackups = await migrate(db, join(dataDirectory, "backups"));
    const store = new Store(db, dataDirectory, options.config);
    const startupRunning = store.outbox.runningAtStartup();
    store.hooks.prune(options.now ?? (new Date().toISOString() as IsoTime));
    store.repairArtifactFiles();
    return Object.assign(store, { startupRunning, migrationBackups });
  } catch (error) {
    db.close();
    throw error;
  }
}
