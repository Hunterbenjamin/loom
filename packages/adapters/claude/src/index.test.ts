// The adapter as the coordinator sees it. No real Claude process is started.

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hint, ProviderSessionId } from "@loom/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HookPayload } from "./hooks.js";
import { type ClaudeAdapterHandle, createClaudeAdapter } from "./index.js";

// Stub only the SDK launch boundary: ordinary tests must never start a real provider.
const sdk = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: () => {
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      close: () => {
        sdk.close();
        finish();
      },
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await done;
            return { done: true, value: undefined };
          },
        };
      },
    };
  },
}));

const samples = JSON.parse(
  readFileSync(
    new URL("./fixtures/payload-samples.json", import.meta.url),
    "utf8",
  ),
) as Record<string, HookPayload>;

const SESSION = "6d3b4239-0b4f-4c87-97c5-ee6146088430" as ProviderSessionId;

describe("createClaudeAdapter", () => {
  let adapter: ClaudeAdapterHandle;
  let dir: string;
  let hints: Hint[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loom-claude-adapter-"));
    hints = [];
    adapter = await createClaudeAdapter({
      mcpServer: { command: "loom", args: ["mcp"] },
    });
    adapter.subscribe((hint) => hints.push(hint));
  });

  afterEach(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (name: string) =>
    fetch(`${adapter.hookBaseUrl}/hook/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(samples[name]),
    });

  test("a hook receipt becomes a hint, keyed by session and worktree", async () => {
    await post("UserPromptSubmit");
    expect(hints).toEqual([
      {
        source: "claude_hook",
        worktreePath:
          "/private/var/folders/q4/40hztcsn5pl4nj5rx75sgzlr0000gn/T/loom-spike-02/repo",
        sessionId: "9b87a656-3e3b-4c6c-b89c-26514a09917f",
      },
    ]);
  });

  test("an internal subagent event raises no hint", async () => {
    await post("SubagentStop:sub");
    expect(hints).toEqual([]);
  });

  test("unsubscribing stops the hints", async () => {
    const unsubscribe = adapter.subscribe(() => {
      throw new Error("should not fire");
    });
    unsubscribe();
    await post("UserPromptSubmit");
    expect(hints).toHaveLength(1);
  });

  test("activityAt is the last hook, and null without evidence", async () => {
    expect(await adapter.activityAt(SESSION)).toBeNull();
    await post("PreToolUse");
    const at = await adapter.activityAt(SESSION);
    expect(at).not.toBeNull();
    expect((await adapter.hookSummary(SESSION)).lastEventAt).toBe(at);
  });

  test("writeSettings points the hooks at this adapter's own receiver", async () => {
    const settingsPath = join(dir, "settings.json");
    await adapter.writeSettings(settingsPath);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].url).toBe(
      `${adapter.hookBaseUrl}/hook/Stop`,
    );
    const mcp = JSON.parse(
      await readFile(join(dir, "settings.mcp.json"), "utf8"),
    );
    expect(mcp).toEqual({
      mcpServers: { loom: { command: "loom", args: ["mcp"] } },
    });
  });

  test("interactiveArgs names the session, or resumes it", () => {
    const settingsPath = "/runs/r1/settings.json";
    expect(
      adapter.interactiveArgs({
        sessionId: SESSION,
        resume: false,
        model: "haiku",
        settingsPath,
      }),
    ).toEqual([
      "--settings",
      "/runs/r1/settings.json",
      "--mcp-config",
      "/runs/r1/settings.mcp.json",
      "--session-id",
      SESSION,
      "--model",
      "haiku",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(
      adapter.interactiveArgs({
        sessionId: SESSION,
        resume: true,
        model: "haiku",
        settingsPath,
      }),
    ).toContain("--resume");
  });

  test.each([false, true])(
    "conversation argv restricts tools on launch and resume (%s)",
    (resume) => {
      const args = adapter.interactiveArgs({
        sessionId: SESSION,
        resume,
        model: "haiku",
        settingsPath: "/runs/main/settings.json",
        readOnly: true,
      });
      expect(args).toContain(resume ? "--resume" : "--session-id");
      expect(args[args.indexOf("--disallowedTools") + 1]?.split(",")).toEqual([
        "Bash",
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "Task",
      ]);
      expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
      expect(args).toEqual(
        expect.arrayContaining([
          "--restricted",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-chrome",
        ]),
      );
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(args).not.toContain("bypassPermissions");
    },
  );

  test("headlessState is null for a session this coordinator didn't launch", async () => {
    expect(await adapter.headlessState(SESSION)).toBeNull();
    await expect(
      adapter.sendHeadless({ sessionId: SESSION, text: "hi" }),
    ).rejects.toThrow(/no headless run/);
  });

  test("a session with no transcript is not resumable", async () => {
    expect(
      await adapter.resumable(
        "00000000-0000-4000-8000-000000000000" as ProviderSessionId,
        null,
      ),
    ).toBe(false);
  });

  test("closeHeadless() terminates the headless run", async () => {
    const settingsPath = join(dir, "settings.json");
    await adapter.writeSettings(settingsPath);

    await adapter.startHeadless({
      sessionId: SESSION,
      resume: false,
      cwd: dir as never,
      model: "haiku",
      settingsPath,
      readOnly: false,
      prompt: "test",
    });

    // Before close, the session should be known
    expect(await adapter.headlessState(SESSION)).not.toBeNull();

    sdk.close.mockClear();
    await adapter.closeHeadless(SESSION);
    await adapter.closeHeadless(SESSION);
    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(await adapter.headlessState(SESSION)).toBeNull();

    // After close, subsequent operations should fail since the run is removed
    await expect(
      adapter.sendHeadless({ sessionId: SESSION, text: "hello" }),
    ).rejects.toThrow(/no headless run/);
  });
});
