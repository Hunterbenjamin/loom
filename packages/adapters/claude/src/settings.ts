// Per-run settings: hooks that point at this coordinator's receiver, plus Loom's MCP server.
//
// Never written to `~/.claude/settings.json`. At user level a dead coordinator shows an error in
// every session after every turn, and a hung one adds its timeout to every hook (spike 02, §6).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOOK_EVENTS } from "./hooks.js";

/** Seconds. Claude's default is 600 (30 for UserPromptSubmit): a stuck coordinator would freeze sessions. */
export const HTTP_HOOK_TIMEOUT_SECONDS = 1;
/** The command hook spawns a shell and curl, so it gets one second beyond curl's own `-m 1`. */
export const COMMAND_HOOK_TIMEOUT_SECONDS = 2;

/** HTTP hooks are skipped for SessionStart; it is delivered by a command hook instead (spike 02, §1). */
export const COMMAND_HOOK_EVENTS = ["SessionStart"] as const;
export const HTTP_HOOK_EVENTS = HOOK_EVENTS.filter(
  (event) => !COMMAND_HOOK_EVENTS.includes(event as "SessionStart"),
);

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ClaudeSettingsFile {
  hooks: Record<
    string,
    {
      matcher: string;
      hooks: (
        | { type: "http"; url: string; timeout: number }
        | { type: "command"; command: string; timeout: number }
      )[];
    }[]
  >;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerEntry>;
}

export interface SettingsRequest {
  /** The receiver's `baseUrl`, e.g. `http://127.0.0.1:47802`. */
  hookBaseUrl: string;
  /** The name Loom's tools appear under, inside Claude, as `mcp__<name>__*`. */
  mcpServerName: string;
  mcpServer: McpServerEntry;
}

const hookUrl = (base: string, event: string): string => {
  const url = new URL(`/hook/${event}`, base);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`hook base URL must be http(s): ${base}`);
  return url.toString();
};

/**
 * Claude Code 2.1.269 ignores `mcpServers` in a `--settings` file, so the MCP server goes in its
 * own `--mcp-config` file beside the settings. Same generator, same lifetime.
 */
export const mcpConfigPathFor = (settingsPath: string): string =>
  settingsPath.endsWith(".json")
    ? `${settingsPath.slice(0, -".json".length)}.mcp.json`
    : `${settingsPath}.mcp.json`;

export function buildSettings(request: SettingsRequest): ClaudeSettingsFile {
  const hooks: ClaudeSettingsFile["hooks"] = {};
  for (const event of COMMAND_HOOK_EVENTS) {
    const url = hookUrl(request.hookBaseUrl, event);
    if (url.includes("'"))
      throw new Error(`hook URL is not shell-safe: ${url}`);
    hooks[event] = [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            // `exit 0` keeps a refused or slow coordinator out of the user's terminal.
            command: `curl -s -m 1 -H 'content-type: application/json' --data-binary @- '${url}' >/dev/null 2>&1; exit 0`,
            timeout: COMMAND_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ];
  }
  for (const event of HTTP_HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: "*",
        hooks: [
          {
            type: "http",
            url: hookUrl(request.hookBaseUrl, event),
            timeout: HTTP_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ];
  }
  return { hooks };
}

export const buildMcpConfig = (request: SettingsRequest): McpConfigFile => ({
  mcpServers: { [request.mcpServerName]: request.mcpServer },
});

/** Writes the settings file and its sibling MCP config. Both are rewritten on every launch. */
export async function writeSettingsFiles(
  settingsPath: string,
  request: SettingsRequest,
): Promise<{ settingsPath: string; mcpConfigPath: string }> {
  const mcpConfigPath = mcpConfigPathFor(settingsPath);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify(buildSettings(request), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify(buildMcpConfig(request), null, 2)}\n`,
    "utf8",
  );
  return { settingsPath, mcpConfigPath };
}
