import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeAdapter,
  ConversationItem,
  ConversationRead,
  IsoTime,
} from "@loom/core";
import { z } from "zod";

const block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});
const line = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  is_meta: z.boolean().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(block)]),
    })
    .optional(),
});

interface Cache {
  path: string;
  inode: number;
  offset: number;
  partial: string;
  items: ConversationItem[];
  tools: Map<string, ConversationItem>;
}
const caches = new Map<string, Cache>();
const clip = (value: string, max: number) => ({
  text: value.slice(0, max),
  clipped: value.length > max,
});
const display = (value: unknown, max = 2048) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.slice(0, max);
};
const defaultPath = (sessionId: string, cwd: string) =>
  join(
    homedir(),
    ".claude",
    "projects",
    cwd.replace(/[^A-Za-z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );

function consume(cache: Cache, raw: string): void {
  let parsed: z.output<typeof line>;
  try {
    const json = JSON.parse(raw) as unknown;
    const result = line.safeParse(json);
    if (!result.success) return;
    parsed = result.data;
  } catch {
    return;
  }
  if (parsed.isSidechain || parsed.isMeta || parsed.is_meta) return;
  if (
    (parsed.type !== "user" && parsed.type !== "assistant") ||
    !parsed.message
  )
    return;
  const uuid = parsed.uuid ?? `line-${cache.items.length}`;
  const at = (parsed.timestamp ?? null) as IsoTime | null;
  const content = parsed.message.content;
  const blocks =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  blocks.forEach((part, index) => {
    if (part.type === "tool_result" && part.tool_use_id) {
      const target = cache.tools.get(part.tool_use_id);
      if (target?.tool) {
        target.tool.output = display(part.content);
        target.tool.status = part.is_error ? "failed" : "done";
      }
      return;
    }
    let item: ConversationItem | null = null;
    if (part.type === "text") {
      const bounded = clip(part.text ?? "", 8192);
      item = {
        id: `${uuid}:${index}`,
        role: parsed.type === "user" ? "user" : "assistant",
        kind: "text",
        ...bounded,
        tool: null,
        at,
      };
    } else if (part.type === "thinking") {
      const bounded = clip(part.thinking ?? "", 8192);
      item = {
        id: `${uuid}:${index}`,
        role: "assistant",
        kind: "thinking",
        ...bounded,
        tool: null,
        at,
      };
    } else if (part.type === "tool_use") {
      item = {
        id: `${uuid}:${index}`,
        role: "assistant",
        kind: "tool",
        text: "",
        clipped: false,
        tool: {
          name: part.name ?? "tool",
          input: display(part.input),
          status: "running",
          output: "",
        },
        at,
      };
      if (part.id) cache.tools.set(part.id, item);
    }
    if (item) cache.items.push(item);
  });
}

export const readConversation: ClaudeAdapter["readConversation"] = async (
  request,
): Promise<ConversationRead> => {
  const path =
    request.transcriptPath ?? defaultPath(request.sessionId, request.cwd);
  const info = await stat(path);
  const key = request.sessionId;
  let cache = caches.get(key);
  if (
    !cache ||
    cache.path !== path ||
    cache.inode !== info.ino ||
    info.size < cache.offset
  ) {
    cache = {
      path,
      inode: info.ino,
      offset: 0,
      partial: "",
      items: [],
      tools: new Map(),
    };
    caches.set(key, cache);
  }
  if (info.size > cache.offset) {
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(info.size - cache.offset);
      const { bytesRead } = await handle.read(
        bytes,
        0,
        bytes.length,
        cache.offset,
      );
      cache.offset += bytesRead;
      const input =
        cache.partial + bytes.subarray(0, bytesRead).toString("utf8");
      const lines = input.split("\n");
      cache.partial = lines.pop() ?? "";
      for (const value of lines) consume(cache, value);
    } finally {
      await handle.close();
    }
  }
  const truncated = cache.items.length > 300;
  return { items: cache.items.slice(-300), truncated };
};
