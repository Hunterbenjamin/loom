import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { z } from "zod";

/** Base64 plus the command envelope must remain below protocol MAX_FRAME_BYTES (64 MiB). */
export const ATTACHMENT_MAX_BYTES = 40 * 1024 * 1024;

const metadata = z.strictObject({
  attachmentId: z.string().uuid(),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  path: z.string().min(1),
});
export type StagedAttachment = z.output<typeof metadata>;

const safeName = (name: string) => {
  const clean = basename(name)
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, 180);
  return clean && clean !== "." && clean !== ".." ? clean : "attachment";
};

export class Attachments {
  private readonly root: string;
  constructor(dataDirectory: string) {
    this.root = resolve(dataDirectory, "attachments");
  }

  async stage(
    name: string,
    mediaType: string,
    dataBase64: string,
  ): Promise<StagedAttachment> {
    const bytes = Buffer.from(dataBase64, "base64");
    if (!bytes.length || bytes.length > ATTACHMENT_MAX_BYTES)
      throw new Error(
        `Attachment must be between 1 byte and ${ATTACHMENT_MAX_BYTES} bytes`,
      );
    const attachmentId = randomUUID();
    const directory = join(this.root, attachmentId);
    const stagedPath = join(directory, safeName(name));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(stagedPath, bytes, { mode: 0o600, flag: "wx" });
    const path = await realpath(stagedPath);
    const value = metadata.parse({
      attachmentId,
      name: safeName(name),
      mediaType,
      path,
    });
    await writeFile(join(directory, "metadata.json"), JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    return value;
  }

  async resolve(ids: string[]): Promise<StagedAttachment[]> {
    return Promise.all(
      ids.map(async (attachmentId) => {
        if (!z.string().uuid().safeParse(attachmentId).success)
          throw new Error("Invalid attachment ID");
        const value = metadata.parse(
          JSON.parse(
            await readFile(
              join(this.root, attachmentId, "metadata.json"),
              "utf8",
            ),
          ),
        );
        const root = `${await realpath(this.root)}${sep}`;
        const path = await realpath(value.path);
        if (value.attachmentId !== attachmentId || !path.startsWith(root))
          throw new Error(
            "Attachment path is outside the attachment directory",
          );
        return { ...value, path };
      }),
    );
  }
}

export function withAttachedFiles(
  text: string,
  attachments: StagedAttachment[],
): string {
  if (!attachments.length) return text;
  return `${text}\n\nAttached files:\n${attachments.map((a) => a.path).join("\n")}`;
}
