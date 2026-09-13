// The pure pieces: the derived IDs, the environment allowlist, WORKFLOW.md's policy and the
// finding mapper. None of these touch a provider, a terminal or the network.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileChange,
  Finding,
  FindingId,
  Sha,
  TaskId,
  TaskState,
} from "@loom/core";
import { expect, test } from "vitest";
import {
  applyStoredSettingsToConfig,
  configFromEnvironment,
  configSchema,
} from "./config.js";
import { deriveClaudeSessionId, newToken, uuidV5 } from "./derive.js";
import { deriveBashPrefixes, FIXED_BASH_PREFIXES } from "./launch.js";
import { indexChanges, mapFindings, mapRange } from "./mapping.js";
import { ENVIRONMENT_ALLOWLIST, runEnvironment } from "./recipes.js";
import { createWorkflowReader, parseWorkflow } from "./workflow.js";

test("a Claude session ID is the UUIDv5 of the run and its epoch", () => {
  const id = deriveClaudeSessionId("t1/planner/0" as never, 0);
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // Pure and deterministic: a retry of the same epoch targets the same session (decision 10).
  expect(deriveClaudeSessionId("t1/planner/0" as never, 0)).toBe(id);
  expect(deriveClaudeSessionId("t1/planner/0" as never, 1)).not.toBe(id);
  expect(deriveClaudeSessionId("t1/planner/1" as never, 0)).not.toBe(id);
  // The published RFC 4122 §4.3 vector, so the implementation itself is checked.
  expect(
    uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
  ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
});

test("a run token is unguessable and never derived from an ID", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => newToken()));
  expect(tokens.size).toBe(64);
  for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(32);
});

test("the pane environment is an allowlist", () => {
  const env = runEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/home/loom",
      CLAUDE_CODE_CHILD_SESSION: "1",
      AWS_SECRET_ACCESS_KEY: "secret",
    },
    { LOOM_MCP_TOKEN: "t" },
  );
  expect(env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/loom",
    LOOM_MCP_TOKEN: "t",
  });
  // Inheriting this one turns off transcript saving, which breaks resuming (principle 7).
  expect(ENVIRONMENT_ALLOWLIST).not.toContain("CLAUDE_CODE_CHILD_SESSION");
});

test("the config refuses an instance or a bind address it cannot parse", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
  };
  expect(configSchema.parse(base).bind).toEqual({
    host: "127.0.0.1",
    port: 47800,
  });
  expect(configSchema.parse({ ...base, bind: "0.0.0.0:1234" }).bind).toEqual({
    host: "0.0.0.0",
    port: 1234,
  });
  expect(() => configSchema.parse({ ...base, bind: "nonsense" })).toThrow();
  expect(() => configSchema.parse({ ...base, instance: "../prod" })).toThrow();
  expect(() => configSchema.parse({ ...base, token: "short" })).toThrow();
});

test("MCP and hook ports default to bind.port+1 and bind.port+2", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
  };
  // Default bind port is 47800, so defaults should be 47801 and 47802
  const config = configSchema.parse(base);
  expect(config.mcpPort).toBe(47801);
  expect(config.hookPort).toBe(47802);

  // Custom bind port should shift the defaults
  const configCustomBind = configSchema.parse({
    ...base,
    bind: "127.0.0.1:8000",
  });
  expect(configCustomBind.mcpPort).toBe(8001);
  expect(configCustomBind.hookPort).toBe(8002);

  // Explicit ports override defaults
  const configCustomPorts = configSchema.parse({
    ...base,
    mcpPort: 9000,
    hookPort: 9001,
  });
  expect(configCustomPorts.mcpPort).toBe(9000);
  expect(configCustomPorts.hookPort).toBe(9001);
});

test("configFromEnvironment reads MCP and hook ports from environment", () => {
  const baseEnv = {
    LOOM_INSTANCE: "dev",
    LOOM_DATA_ROOT: "/tmp/loom",
    LOOM_TOKEN: "0123456789abcdef0123",
  };
  const env = {
    ...baseEnv,
    LOOM_MCP_PORT: "9000",
    LOOM_HOOK_PORT: "9001",
    LOOM_MODEL_LEAD: "fake-lead-model",
  };
  const config = configFromEnvironment(env);
  expect(config.mcpPort).toBe(9000);
  expect(config.hookPort).toBe(9001);
  expect(config.leadModel).toBe("fake-lead-model");

  // Without env vars, should default to bind.port+1 and bind.port+2
  const configWithDefaults = configFromEnvironment(baseEnv);
  expect(configWithDefaults.mcpPort).toBe(47801); // 47800 + 1
  expect(configWithDefaults.hookPort).toBe(47802); // 47800 + 2
});

test("WORKFLOW.md exposes only commands it can fully validate", async () => {
  expect(
    parseWorkflow("# Workflow\n\n## Test\n\n```sh\npnpm test\n```\n"),
  ).toEqual({ test: "pnpm test" });
  expect(
    parseWorkflow(
      "## dev server\n```sh\npnpm dev\n```\n## teardown\n```\nmake down\n```",
    ),
  ).toEqual({ dev_server: "pnpm dev", teardown: "make down" });
  // Prose without a fenced block is for humans; a heading with no command is not a command.
  expect(parseWorkflow("## Notes\n\nRun it yourself.\n")).toEqual({});
  // A file that says two different things under one name is malformed, not last-one-wins.
  expect(() =>
    parseWorkflow("## test\n```\na\n```\n## Test\n```\nb\n```"),
  ).toThrow();
});

test("a missing or malformed WORKFLOW.md exposes nothing, and says so once", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-workflow-"));
  try {
    const warnings: string[] = [];
    const reader = createWorkflowReader((message) => warnings.push(message));
    expect(await reader.read(root)).toEqual({});
    expect(warnings).toHaveLength(0);

    await writeFile(join(root, "WORKFLOW.md"), "## test\n```\na\n```\n");
    expect(await reader.read(root)).toEqual({ test: "a" });

    await writeFile(
      join(root, "WORKFLOW.md"),
      "## test\n```\na\n```\n## test\n```\nb\n```\n",
    );
    // Half-parsed commands would be run by an agent, so a malformed file exposes none at all.
    expect(await reader.read(root)).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("WORKFLOW.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const change = (over: Partial<FileChange> = {}): FileChange => ({
  status: "modified",
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  oldBlobOid: "a".repeat(40) as never,
  newBlobOid: "b".repeat(40) as never,
  binary: false,
  hunks: [],
  ...over,
});

test("a finding moves with its file, and is never silently re-pointed", () => {
  // Nothing changed: the anchor still points where it did.
  expect(mapRange(undefined, 10, 12)).toMatchObject({
    startLine: 10,
    status: "exact",
  });
  // Lines added above shift it down.
  expect(
    mapRange(
      change({
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 4 }],
      }),
      10,
      12,
    ),
  ).toMatchObject({ startLine: 13, endLine: 15, status: "moved" });
  // A hunk that rewrote the anchored lines is ambiguous, and ambiguity keeps the finding open.
  expect(
    mapRange(
      change({
        hunks: [{ oldStart: 9, oldLines: 5, newStart: 9, newLines: 2 }],
      }),
      10,
      12,
    ),
  ).toMatchObject({ startLine: null, status: "ambiguous" });
  // A deleted file is outdated, never resolved.
  expect(
    mapRange(change({ status: "deleted", newPath: null }), 10, 12),
  ).toMatchObject({ status: "outdated", path: null });
  // A rename carries the finding to the new path.
  expect(
    mapRange(change({ status: "renamed", newPath: "src/b.ts" }), 3, 3),
  ).toMatchObject({ path: "src/b.ts", status: "moved" });
});

test("mapFindings gives each anchored finding a new location version", () => {
  const anchored: Finding = {
    id: "t1/reviewer/1/0" as FindingId,
    taskId: "t1" as TaskId,
    round: 1,
    source: "reviewer",
    externalId: null,
    createdByRunId: null,
    severity: "major",
    blocking: true,
    title: "Fix",
    body: "",
    status: "open",
    reopenCount: 0,
    anchor: {
      baseSha: "0".repeat(40) as Sha,
      headSha: "1".repeat(40) as Sha,
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      oldBlobOid: null,
      newBlobOid: null,
      side: "new",
      startLine: 10,
      endLine: 10,
      startColumn: null,
      endColumn: null,
      selectedText: "x",
      selectedTextHash: "h",
      contextBeforeHash: "h",
      contextAfterHash: "h",
      normalization: "lf-v1",
    },
    location: null,
    resolution: null,
    createdAt: "2026-09-12T00:00:00.000Z" as never,
    updatedAt: "2026-09-12T00:00:00.000Z" as never,
  };
  const taskLevel: Finding = {
    ...anchored,
    id: "t1/ci/1" as FindingId,
    anchor: null,
  };
  const mapped = mapFindings({
    findings: [anchored, taskLevel],
    findingIds: [anchored.id, taskLevel.id],
    toHeadSha: "2".repeat(40) as Sha,
    changes: indexChanges([
      change({
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3 }],
      }),
    ]),
    mappedAt: "2026-09-12T00:01:00.000Z",
  });
  // A task-level finding has nothing to anchor, so it gets no location.
  expect(mapped).toHaveLength(1);
  expect(mapped[0]).toMatchObject({
    findingId: anchored.id,
    location: { startLine: 12, status: "moved", version: 1 },
  });
});

test("fixed bash prefixes include git and pnpm commands", () => {
  expect(FIXED_BASH_PREFIXES).toContain("git add");
  expect(FIXED_BASH_PREFIXES).toContain("git commit");
  expect(FIXED_BASH_PREFIXES).toContain("git status");
  expect(FIXED_BASH_PREFIXES).toContain("git diff");
  expect(FIXED_BASH_PREFIXES).toContain("git log");
  expect(FIXED_BASH_PREFIXES).toContain("pnpm install");
  expect(FIXED_BASH_PREFIXES).toContain("pnpm exec vitest");
  expect(FIXED_BASH_PREFIXES).toContain("pnpm exec biome");
  expect(FIXED_BASH_PREFIXES).toContain("pnpm exec tsc");
  // These should NOT be included
  expect(FIXED_BASH_PREFIXES).not.toContain("git push");
  expect(FIXED_BASH_PREFIXES).not.toContain("git merge");
  expect(FIXED_BASH_PREFIXES).not.toContain("gh");
  expect(FIXED_BASH_PREFIXES).not.toContain("rm");
  expect(FIXED_BASH_PREFIXES).not.toContain("curl");
});

test("deriveBashPrefixes returns fixed prefixes when no workflow reader is provided", async () => {
  const state = {
    task: { id: "t1" as TaskId, repoId: "r1" as never },
    runs: [],
  } as unknown as TaskState;
  const prefixes = await deriveBashPrefixes(state);
  expect(prefixes).toEqual(FIXED_BASH_PREFIXES);
});

test("deriveBashPrefixes combines fixed prefixes with WORKFLOW.md commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-bash-prefixes-"));
  try {
    const state = {
      task: { id: "t1" as TaskId, repoId: "r1" as never },
      runs: [],
    } as unknown as TaskState;
    const reader = createWorkflowReader();

    // Create a WORKFLOW.md with custom commands
    await writeFile(
      join(root, "WORKFLOW.md"),
      "## test\n```\npnpm test\n```\n## lint\n```\npnpm lint\n```\n",
    );

    const repoById = (repoId: string) =>
      repoId === "r1" ? { root } : undefined;

    const prefixes = await deriveBashPrefixes(state, reader, repoById);

    // Should include all fixed prefixes
    for (const fixed of FIXED_BASH_PREFIXES) {
      expect(prefixes).toContain(fixed);
    }

    // Should also include WORKFLOW.md commands as "pnpm <name>"
    expect(prefixes).toContain("pnpm test");
    expect(prefixes).toContain("pnpm lint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deriveBashPrefixes deduplicates commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-bash-dedup-"));
  try {
    const state = {
      task: { id: "t1" as TaskId, repoId: "r1" as never },
      runs: [],
    } as unknown as TaskState;
    const reader = createWorkflowReader();

    // Create a WORKFLOW.md with a command that matches a fixed prefix
    await writeFile(
      join(root, "WORKFLOW.md"),
      "## install\n```\npnpm install\n```\n",
    );

    const repoById = (repoId: string) =>
      repoId === "r1" ? { root } : undefined;

    const prefixes = await deriveBashPrefixes(state, reader, repoById);

    // Should not duplicate "pnpm install"
    const count = prefixes.filter((p) => p === "pnpm install").length;
    expect(count).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deriveBashPrefixes returns fixed prefixes when WORKFLOW.md is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-bash-missing-"));
  try {
    const state = {
      task: { id: "t1" as TaskId, repoId: "r1" as never },
      runs: [],
    } as unknown as TaskState;
    const reader = createWorkflowReader();

    const repoById = (repoId: string) =>
      repoId === "r1" ? { root } : undefined;

    const prefixes = await deriveBashPrefixes(state, reader, repoById);

    // Should return fixed prefixes even if WORKFLOW.md is missing
    expect(prefixes).toEqual(FIXED_BASH_PREFIXES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deriveBashPrefixes returns fixed prefixes when repoById is not provided", async () => {
  const state = {
    task: { id: "t1" as TaskId, repoId: "r1" as never },
    runs: [],
  } as unknown as TaskState;
  const reader = createWorkflowReader();

  const prefixes = await deriveBashPrefixes(state, reader);

  expect(prefixes).toEqual(FIXED_BASH_PREFIXES);
});

test("runModes defaults to interactive for all roles when not specified", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
  };
  const config = configSchema.parse(base);
  expect(config.runModes).toEqual({
    planner: "interactive",
    implementer: "interactive",
    reviewer: "interactive",
  });
});

test("runModes can be overridden via configSchema", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
  };
  const config = configSchema.parse({
    ...base,
    runModes: "planner=headless,implementer=interactive,reviewer=headless",
  });
  expect(config.runModes).toEqual({
    planner: "headless",
    implementer: "interactive",
    reviewer: "headless",
  });
});

test("runModes can be partially overridden", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
  };
  const config = configSchema.parse({
    ...base,
    runModes: "planner=headless",
  });
  expect(config.runModes).toEqual({
    planner: "headless",
    implementer: "interactive",
    reviewer: "interactive",
  });
});

test("runModes trims whitespace around entries", () => {
  const config = configSchema.parse({
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
    runModes: " planner = headless , reviewer = interactive ",
  });
  expect(config.runModes).toEqual({
    planner: "headless",
    implementer: "interactive",
    reviewer: "interactive",
  });
});

test("configFromEnvironment reads LOOM_RUN_MODES from environment", () => {
  const baseEnv = {
    LOOM_INSTANCE: "dev",
    LOOM_DATA_ROOT: "/tmp/loom",
    LOOM_TOKEN: "0123456789abcdef0123",
  };
  const env = {
    ...baseEnv,
    LOOM_RUN_MODES: "planner=headless,reviewer=headless",
  };
  const config = configFromEnvironment(env);
  expect(config.runModes).toEqual({
    planner: "headless",
    implementer: "interactive",
    reviewer: "headless",
  });
});

test("runModes rejects invalid role in LOOM_RUN_MODES", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
    runModes: "invalid=headless",
  };
  expect(() => configSchema.parse(base)).toThrow(/Invalid role/);
});

test("runModes rejects invalid mode in LOOM_RUN_MODES", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
    runModes: "planner=invalid",
  };
  expect(() => configSchema.parse(base)).toThrow(/Invalid mode/);
});

test("runModes rejects malformed entries in LOOM_RUN_MODES", () => {
  const base = {
    instance: "dev",
    dataRoot: "/tmp/loom",
    worktreeRoot: "/tmp/loom/worktrees",
    token: "0123456789abcdef0123",
    models: { codex: "a", claude: "b" },
    runModes: "planner:headless",
  };
  expect(() => configSchema.parse(base)).toThrow(/expected "role=mode" format/);
  expect(() =>
    configSchema.parse({
      ...base,
      runModes: "planner=headless,,reviewer=headless",
    }),
  ).toThrow(/expected "role=mode" format/);
});

test("task provider overrides and explicit Codex reasoning are validated", () => {
  const env = {
    LOOM_INSTANCE: "dev",
    LOOM_DATA_ROOT: "/tmp/loom",
    LOOM_TOKEN: "0123456789abcdef0123",
    LOOM_PROVIDER_PLANNER: "codex",
    LOOM_PROVIDER_IMPLEMENTER: "codex",
    LOOM_PROVIDER_REVIEWER: "codex",
    LOOM_MODEL_CODEX: "gpt-5.6-sol",
    LOOM_CODEX_REASONING_EFFORT: "medium",
  };
  const config = configFromEnvironment(env);
  expect(config.providerOverrides).toEqual({
    planner: "codex",
    implementer: "codex",
    reviewer: "codex",
  });
  expect(config.models.codex).toBe("gpt-5.6-sol");
  expect(config.codexReasoningEffort).toBe("medium");
  expect(config.settingsEnvironment.roles?.implementer?.model).toBeUndefined();
  expect(config.providerEnvironment).toEqual({
    models: { codex: "gpt-5.6-sol" },
    codexReasoningEffort: "medium",
  });
  expect(() =>
    configFromEnvironment({ ...env, LOOM_PROVIDER_PLANNER: "sol" }),
  ).toThrow();
  expect(() =>
    configFromEnvironment({ ...env, LOOM_CODEX_REASONING_EFFORT: "medum" }),
  ).toThrow();
});

test("stored restart settings are resolved before adapter construction", () => {
  const baseline = configFromEnvironment({
    LOOM_INSTANCE: "dev",
    LOOM_DATA_ROOT: "/tmp/loom",
    LOOM_TOKEN: "0123456789abcdef0123",
  });
  const runtime = structuredClone(baseline);
  applyStoredSettingsToConfig(
    runtime,
    baseline,
    {
      runtime: {
        worktreeRoot: "/tmp/custom-worktrees",
        tmuxExecutable: "/opt/loom/tmux",
        codexExecutable: "/opt/loom/codex",
        claudeExecutable: "/opt/loom/claude",
        heartbeatMs: 9000,
      },
    },
    true,
  );
  expect(runtime).toMatchObject({
    worktreeRoot: "/tmp/custom-worktrees",
    tmuxExecutable: "/opt/loom/tmux",
    codexExecutable: "/opt/loom/codex",
    claudeExecutable: "/opt/loom/claude",
    heartbeatMs: 9000,
  });
});
