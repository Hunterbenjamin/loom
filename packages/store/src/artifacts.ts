import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Artifact, ArtifactKind, TaskId, TaskState } from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { artifactSchema } from "./entity-schemas.js";
import { assertSame } from "./records.js";
import { decode, encode, text } from "./schema-helpers.js";

const rowSchema = z.object({ data: text, content: text });
export interface StoredArtifact {
  artifact: Artifact;
  content: unknown;
}
export function readArtifactRow(raw: unknown): StoredArtifact {
  const row = rowSchema.parse(raw);
  const artifact = decode(artifactSchema, row.data);
  const content = decode(z.json(), row.content);
  if (
    createHash("sha256").update(row.content).digest("hex") !== artifact.sha256
  )
    throw new Error("Artifact content/hash disagreement");
  if (
    artifact.path !==
    `tasks/${artifact.taskId}/${artifact.kind}/v${artifact.version}.json`
  )
    throw new Error("Artifact path/version disagreement");
  return { artifact, content };
}
export function readArtifact(
  db: Database.Database,
  taskId: TaskId,
  kind: ArtifactKind,
  version: number,
): StoredArtifact {
  const result = readArtifactRow(
    db
      .prepare(
        "SELECT data, content FROM artifacts WHERE task_id = ? AND kind = ? AND version = ?",
      )
      .get(taskId, kind, version),
  );
  if (
    result.artifact.taskId !== taskId ||
    result.artifact.kind !== kind ||
    result.artifact.version !== version
  )
    throw new Error("Artifact metadata/version disagreement");
  return result;
}
export function saveArtifacts(db: Database.Database, state: TaskState): void {
  const kinds = new Set<string>();
  for (const raw of state.artifacts) {
    const artifact = artifactSchema.parse(raw);
    if (kinds.has(artifact.kind))
      throw new Error("Duplicate artifact kind in snapshot");
    kinds.add(artifact.kind);
    if (
      artifact.taskId !== state.task.id ||
      !(artifact.kind in state.artifactContents)
    )
      throw new Error("Missing artifact content or wrong task");
    const content = encode(state.artifactContents[artifact.kind]);
    readArtifactRow({ data: encode(artifact), content });
    const previous = db
      .prepare(
        "SELECT data, content FROM artifacts WHERE task_id = ? AND kind = ? AND version = ?",
      )
      .get(state.task.id, artifact.kind, artifact.version);
    if (previous !== undefined) {
      assertSame(
        readArtifactRow(previous),
        { artifact, content: JSON.parse(content) },
        "Immutable artifact version changed",
      );
      const latest = db
        .prepare(
          "SELECT MAX(version) FROM artifacts WHERE task_id = ? AND kind = ?",
        )
        .pluck()
        .get(state.task.id, artifact.kind);
      if (artifact.version !== latest)
        throw new Error("Snapshot contains an outdated artifact version");
    } else {
      const latest = db
        .prepare(
          "SELECT MAX(version) FROM artifacts WHERE task_id = ? AND kind = ?",
        )
        .pluck()
        .get(state.task.id, artifact.kind);
      if (artifact.version <= (latest === null ? 0 : z.number().parse(latest)))
        throw new Error("Artifact version must increase");
      db.prepare(
        "INSERT INTO artifacts(id, task_id, kind, version, data, content) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        artifact.id,
        state.task.id,
        artifact.kind,
        artifact.version,
        encode(artifact),
        content,
      );
    }
  }
  for (const kind of Object.keys(state.artifactContents))
    if (!kinds.has(kind)) throw new Error("Artifact content has no metadata");
  const savedKinds = db
    .prepare("SELECT DISTINCT kind FROM artifacts WHERE task_id = ?")
    .pluck()
    .all(state.task.id);
  if (savedKinds.some((kind) => !kinds.has(text.parse(kind))))
    throw new Error("Snapshot omitted an artifact kind");
}
/** SQL is the durable owner. Files are immutable projections, repairable after a crash. */
export function materialize(
  dataDirectory: string,
  stored: StoredArtifact,
): void {
  const { artifact } = stored;
  const root = realpathSync(dataDirectory);
  const destination = resolve(root, artifact.path);
  const rel = relative(root, destination);
  if (
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    !rel.startsWith(`tasks${sep}`)
  )
    throw new Error("Artifact path escapes data directory");
  // Reject symlink parents so a persisted artifact cannot write outside this instance.
  let current = root;
  for (const part of relative(root, dirname(destination)).split(sep)) {
    current = join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Artifact directory must not be a symlink");
  }
  const content = encode(stored.content);
  try {
    if (lstatSync(destination).isSymbolicLink())
      throw new Error("Artifact file must not be a symlink");
    if (readFileSync(destination, "utf8") === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    const directory = openSync(dirname(destination), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class ArtifactStore {
  constructor(
    private readonly db: Database.Database,
    private readonly dataDirectory: string,
  ) {}
  artifact(taskId: TaskId, kind: ArtifactKind, version: number) {
    return readArtifact(this.db, taskId, kind, version);
  }
  materializeArtifact(
    taskId: TaskId,
    kind: ArtifactKind,
    version: number,
  ): void {
    materialize(this.dataDirectory, this.artifact(taskId, kind, version));
  }
  repairArtifactFiles(): void {
    for (const row of this.db
      .prepare("SELECT data, content FROM artifacts ORDER BY rowid")
      .all())
      materialize(this.dataDirectory, readArtifactRow(row));
  }
}
