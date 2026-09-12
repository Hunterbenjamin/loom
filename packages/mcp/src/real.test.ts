// Opt-in: one private headless Claude Haiku session. No terminal or global config access.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { setup } from "./test-support.js";
import { serveHttp } from "./transports.js";

const resultSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string(),
});
test.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "Claude --model haiku calls get_task_context using a separate MCP config",
  { timeout: 180_000 },
  async () => {
    const env = setup();
    const token = randomUUID();
    env.host.tokens.clear();
    env.host.tokens.set(token, env.run.id);
    let contextCalls = 0;
    const options = {
      ...env.options,
      host: {
        submit: env.host.submit.bind(env.host),
        context: (id: typeof env.run.id) => {
          contextCalls++;
          return env.host.context(id);
        },
      },
    };
    const listener = await serveHttp(options);
    const dir = await mkdtemp(join(tmpdir(), "loom-mcp-real-"));
    try {
      const sessionId = randomUUID();
      await writeFile(
        join(dir, "session.json"),
        JSON.stringify({ sessionId }),
        { mode: 0o600 },
      );
      const mcpConfig = join(dir, "mcp.json");
      await writeFile(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            loom: {
              type: "http",
              url: listener.url.href,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined &&
            !key.startsWith("CLAUDE_CODE_") &&
            !key.startsWith("HERDR_") &&
            key !== "CLAUDECODE",
        ),
      );
      const child = spawn(
        "claude",
        [
          "--print",
          "--model",
          "haiku",
          "--session-id",
          sessionId,
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          mcpConfig,
          "--tools",
          "",
          "--allowedTools",
          "mcp__loom__get_task_context",
          "--permission-mode",
          "dontAsk",
          "--disable-slash-commands",
          "--output-format",
          "json",
          "Call mcp__loom__get_task_context exactly once. Then reply with only the task title returned by that tool.",
        ],
        { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "ignore"] },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < 1_000_000) stdout += chunk;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(code).toBe(0);
      // Never emit raw provider output: assert only the validated result and host-side receipt.
      const parsed = resultSchema.safeParse(JSON.parse(stdout));
      expect(parsed.success).toBe(true);
      expect(parsed.success && !parsed.data.is_error).toBe(true);
      expect(
        parsed.success &&
          parsed.data.result.includes(env.host.state.task.title),
      ).toBe(true);
      expect(contextCalls).toBe(1);
      expect(env.host.inputs).toHaveLength(0);
    } finally {
      await listener.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
