import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  Attachments,
  withAttachedFiles,
} from "./attachments.js";

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

test("stages sanitized private files and resolves only their recorded paths", async () => {
  directory = await mkdtemp(join(tmpdir(), "loom-attachments-"));
  const attachments = new Attachments(directory);
  const staged = await attachments.stage(
    "../screen?.png",
    "image/png",
    Buffer.from("png").toString("base64"),
  );
  expect(staged.name).toBe("screen_.png");
  expect(await readFile(staged.path, "utf8")).toBe("png");
  await expect(attachments.resolve([staged.attachmentId])).resolves.toEqual([
    staged,
  ]);
  expect(withAttachedFiles("Look", [staged])).toContain(staged.path);

  await writeFile(
    join(directory, "attachments", staged.attachmentId, "metadata.json"),
    JSON.stringify({ ...staged, path: join(directory, "outside") }),
  );
  await writeFile(join(directory, "outside"), "no");
  await expect(attachments.resolve([staged.attachmentId])).rejects.toThrow(
    "outside",
  );
});

test("rejects attachments over the protocol-safe cap", async () => {
  directory = await mkdtemp(join(tmpdir(), "loom-attachments-"));
  const attachments = new Attachments(directory);
  await expect(
    attachments.stage(
      "large.bin",
      "application/octet-stream",
      Buffer.alloc(ATTACHMENT_MAX_BYTES + 1).toString("base64"),
    ),
  ).rejects.toThrow(String(ATTACHMENT_MAX_BYTES));
});
