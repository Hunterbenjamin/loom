import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HOOK_EVENTS } from "./hooks.js";
import {
  buildMcpConfig,
  buildSettings,
  mcpConfigPathFor,
  type SettingsRequest,
  writeSettingsFiles,
} from "./settings.js";

const request: SettingsRequest = {
  hookBaseUrl: "http://127.0.0.1:47802",
  mcpServerName: "loom",
  mcpServer: {
    command: "/usr/local/bin/loom",
    args: ["mcp", "--run", "t1/implementer/0"],
    env: { LOOM_INSTANCE: "dev" },
  },
};

describe("per-run settings", () => {
  test("every event is registered", () => {
    expect(Object.keys(buildSettings(request)).sort()).toEqual([
      "hooks",
      "permissions",
    ]);
    // Loom's tools are pre-allowed at server level; a headless run cannot answer a prompt.
    expect(buildSettings(request).permissions).toEqual({
      allow: [`mcp__${request.mcpServerName}`],
    });
    expect(Object.keys(buildSettings(request).hooks).sort()).toEqual(
      [...HOOK_EVENTS].sort(),
    );
  });

  test("SessionStart is a command hook: HTTP hooks are skipped for it", () => {
    const [entry] = buildSettings(request).hooks.SessionStart ?? [];
    expect(entry?.matcher).toBe("*");
    expect(entry?.hooks[0]).toEqual({
      type: "command",
      command:
        "curl -s -m 1 -H 'content-type: application/json' --data-binary @- " +
        "'http://127.0.0.1:47802/hook/SessionStart' >/dev/null 2>&1; exit 0",
      timeout: 2,
    });
  });

  test("the command hook swallows its own failure, so a dead coordinator stays invisible", () => {
    const command = buildSettings(request).hooks.SessionStart?.[0]?.hooks[0];
    expect(command).toMatchObject({ type: "command" });
    if (command?.type !== "command") throw new Error("expected a command hook");
    expect(command.command).toMatch(/; exit 0$/);
    expect(command.command).toContain("-m 1");
  });

  test("every other event is an HTTP hook with a one-second timeout", () => {
    const { hooks } = buildSettings(request);
    for (const event of HOOK_EVENTS) {
      if (event === "SessionStart") continue;
      expect(hooks[event]?.[0]?.hooks[0]).toEqual({
        type: "http",
        url: `http://127.0.0.1:47802/hook/${event}`,
        timeout: 1,
      });
    }
  });

  test("a hook base URL that isn't http is refused", () => {
    expect(() =>
      buildSettings({ ...request, hookBaseUrl: "file:///etc/passwd" }),
    ).toThrow(/http/);
  });

  test("the MCP server goes in its own config file, beside the settings", () => {
    expect(buildMcpConfig(request)).toEqual({
      mcpServers: {
        loom: {
          command: "/usr/local/bin/loom",
          args: ["mcp", "--run", "t1/implementer/0"],
          env: { LOOM_INSTANCE: "dev" },
        },
      },
    });
    expect(mcpConfigPathFor("/runs/r1/settings.json")).toBe(
      "/runs/r1/settings.mcp.json",
    );
    expect(mcpConfigPathFor("/runs/r1/settings")).toBe(
      "/runs/r1/settings.mcp.json",
    );
  });
});

describe("writeSettingsFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loom-claude-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes both files under the run's own directory", async () => {
    const settingsPath = join(dir, "run", "settings.json");
    const written = await writeSettingsFiles(settingsPath, request);

    expect(written).toEqual({
      settingsPath,
      mcpConfigPath: join(dir, "run", "settings.mcp.json"),
    });
    expect(JSON.parse(await readFile(written.settingsPath, "utf8"))).toEqual(
      buildSettings(request),
    );
    expect(JSON.parse(await readFile(written.mcpConfigPath, "utf8"))).toEqual(
      buildMcpConfig(request),
    );
  });

  test("rewriting is idempotent", async () => {
    const settingsPath = join(dir, "settings.json");
    await writeSettingsFiles(settingsPath, request);
    const first = await readFile(settingsPath, "utf8");
    await writeSettingsFiles(settingsPath, request);
    expect(await readFile(settingsPath, "utf8")).toBe(first);
  });
});
