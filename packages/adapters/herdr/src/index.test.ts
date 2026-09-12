import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderSessionId, WorktreePath } from "@loom/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHerdrAdapter,
  launchPrelude,
  scrubEnvironment,
} from "./index.js";
import {
  acknowledgePrelude,
  fakeServer,
  fixture,
  type Handler,
} from "./test-server.js";

const running: Awaited<ReturnType<typeof fakeServer>>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});
async function setup(handler: Handler, extra = {}) {
  const server = await fakeServer(handler);
  running.push(server);
  return {
    ...server,
    adapter: createHerdrAdapter({
      socketPath: server.path,
      sessionName: "loom-test-herdr",
      pollMs: 1,
      ...extra,
    }),
  };
}
const notFound = { error: { code: "agent_not_found", message: "not found" } };
const ok = { result: { type: "ok" } };

it("scrubs the caller environment without mutating it", () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_NEW: "private",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_NEW: "1",
    CLAUDECODE: "1",
    CODEX_HOME: "/isolated",
    KEEP: "yes",
  };
  expect(scrubEnvironment(env)).toEqual({
    CODEX_HOME: "/isolated",
    KEEP: "yes",
  });
  expect(env.HERDR_ENV).toBe("1");
});

it.each(["/bin/bash", "/bin/zsh"])(
  "scrubs the actual provider environment and preserves argv under %s",
  async (shell) => {
    const server = await setup(() => ok);
    const provider = join(server.directory, "codex");
    const output = join(server.directory, "output.json");
    await writeFile(
      provider,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify({bad: Object.keys(process.env).filter(k=>/^(HERDR_|CLAUDE_CODE_)/.test(k)||k==='CLAUDECODE'), keep:process.env.KEEP, args:process.argv.slice(2)}));\n`,
      { mode: 0o700 },
    );
    const marker = join(server.directory, "quote's ready");
    await promisify(execFile)(
      shell,
      [
        "-c",
        `${launchPrelude("codex", marker)}\ncodex "$@"`,
        "probe",
        "resume",
        "a b",
        "$(false)",
        "--remote",
        "unix:///private/socket",
      ],
      {
        env: {
          ...process.env,
          PATH: `${server.directory}:/usr/bin:/bin`,
          PROBE_OUT: output,
          KEEP: "yes",
          HERDR_ENV: "1",
          HERDR_EXTRA: "1",
          CLAUDE_CODE_CHILD_SESSION: "1",
          CLAUDE_CODE_FUTURE: "1",
          CLAUDECODE: "1",
        },
      },
    );
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      bad: [],
      keep: "yes",
      args: ["resume", "a b", "$(false)", "--remote", "unix:///private/socket"],
    });
  },
);

it.each(["/exit", "!touch danger", " \t/command", "\n!command"])(
  "refuses %j before opening a socket",
  async (text) => {
    const { adapter, requests } = await setup(() => {
      throw new Error("must not call");
    });
    expect(await adapter.prompt("fixture-claude", text)).toBe("refused");
    expect(requests).toEqual([]);
  },
);

it.each([
  ["agent_blocked", "blocked"],
  ["agent_prompt_stalled", "stalled"],
  ["agent_not_found", "not_found"],
])("maps %s without retrying", async (code, result) => {
  const { adapter, requests } = await setup(() => ({
    error: { code, message: "private text" },
  }));
  expect(await adapter.prompt("fixture-claude", "plain prompt")).toBe(result);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.params).toEqual({
    target: "fixture-claude",
    text: "plain prompt",
  });
});

it("replays the recorded blocked prompt and sends no keys", async () => {
  const { adapter, requests } = await setup(() =>
    fixture("prompt-blocked", "/tmp"),
  );
  expect(await adapter.prompt("fixture-claude", "plain prompt")).toBe(
    "blocked",
  );
  expect(requests.map((r) => r.method)).toEqual(["agent.prompt"]);
});

it("reports transport and unknown API errors instead of treating them as absent", async () => {
  const { adapter } = await setup(() => ({
    error: { code: "permission_denied", message: "secret-value" },
  }));
  await expect(adapter.getAgent("fixture-claude")).rejects.toMatchObject({
    code: "permission_denied",
    message: "Herdr: permission_denied",
  });
});

it("normalizes real paths, reports screen state, and keeps session paths distinct from IDs", async () => {
  const { adapter } = await setup((req) =>
    req.params.target === "absent"
      ? notFound
      : fixture("agent-session", "/tmp"),
  );
  expect(await adapter.getAgent("absent")).toBeNull();
  expect(await adapter.getAgent("fixture-claude")).toEqual({
    name: "fixture-claude",
    paneId: "w3:p1",
    cwd: await realpath("/tmp"),
    state: "blocked",
    agentSessionId: "00000000-0000-4000-8000-000000000001",
  });
});

it("uses an explicit session for attach, Esc for interruption, and the integration source for reportSession", async () => {
  const { adapter, requests } = await setup(() => ok);
  await adapter.interrupt("fixture-claude");
  await adapter.reportSession(
    "w3:p1",
    "codex",
    "thread-1" as ProviderSessionId,
  );
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    {
      method: "agent.send_keys",
      params: { target: "fixture-claude", keys: ["esc"] },
    },
    {
      method: "pane.report_agent_session",
      params: {
        pane_id: "w3:p1",
        source: "herdr:codex",
        agent: "codex",
        agent_session_id: "thread-1",
        session_start_source: "resume",
      },
    },
  ]);
  expect(adapter.attachArgs("fixture-claude")).toEqual([
    "herdr",
    "--session",
    "loom-test-herdr",
    "agent",
    "attach",
    "fixture-claude",
  ]);
  expect(() => adapter.attachArgs("--takeover")).toThrow();
});

it("opens an existing directory once, joins by realpath, and never creates a git worktree", async () => {
  let created = false;
  const { adapter, requests } = await setup(async (req) => {
    if (req.method === "pane.list")
      return {
        result: {
          type: "pane_list",
          panes: created
            ? [{ pane_id: "w3:p1", workspace_id: "w3", cwd: "/tmp" }]
            : [],
        },
      };
    created = true;
    return fixture("workspace-created", "/tmp");
  });
  const req = { cwd: "/tmp" as WorktreePath, label: "fixture" };
  const results = await Promise.all([
    adapter.openWorkspace(req),
    adapter.openWorkspace(req),
  ]);
  expect(results[0]).toEqual({ workspaceId: "w3", rootPaneId: "w3:p1" });
  expect(results[1]).toEqual(results[0]);
  expect(requests.map((r) => r.method)).toEqual([
    "pane.list",
    "workspace.create",
    "pane.list",
  ]);
  expect(requests[1]?.params).toEqual({
    cwd: await realpath("/tmp"),
    label: "fixture",
    focus: false,
  });
});

async function startupFixture(
  outcome: "blocked" | "ready" | "timeout" | "missing",
  options = {},
) {
  let launched = false;
  const result = await setup(async (req) => {
    switch (req.method) {
      case "agent.get": {
        if (!launched) return notFound;
        if (outcome === "timeout" || outcome === "missing") return notFound;
        const r = (await fixture("startup-blocked", "/tmp")) as {
          result: { agent: Record<string, unknown> };
        };
        if (outcome === "ready")
          Object.assign(r.result.agent, {
            agent_status: "unknown",
            launch_pending: false,
            interactive_ready: true,
          });
        return r;
      }
      case "pane.process_info":
        if (launched)
          return {
            result: {
              type: "pane_process_info",
              process_info: {
                pane_id: "w3:p1",
                shell_pid: 10,
                foreground_process_group_id: outcome === "missing" ? 10 : 20,
                foreground_processes:
                  outcome === "missing"
                    ? []
                    : [
                        {
                          pid: 20,
                          name: "codex",
                          argv: [
                            "/local/bin/codex",
                            "resume",
                            "thread-1",
                            "--remote",
                            "unix:///private/socket",
                          ],
                        },
                      ],
              },
            },
          };
        return {
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "w3:p1",
              shell_pid: 10,
              foreground_process_group_id: 10,
              foreground_processes: [{ pid: 10, name: "zsh", argv: ["-zsh"] }],
            },
          },
        };
      case "pane.send_input":
        return acknowledgePrelude(req);
      case "agent.start": {
        launched = true;
        const r = (await fixture("startup-pending", "/tmp")) as {
          result: { agent: Record<string, unknown> };
        };
        r.result.agent.name = req.params.name;
        return r;
      }
      case "agent.rename":
        return {
          result: {
            type: "agent_info",
            agent: {
              name: req.params.name,
              pane_id: "w3:p1",
              agent_status: "unknown",
              cwd: "/tmp",
            },
          },
        };
      default:
        throw new Error(req.method);
    }
  }, options);
  return result;
}
const startReq = {
  name: "fixture-claude",
  kind: "claude" as const,
  paneId: "w3:p1",
  args: ["--model", "haiku", "--session-id", "session-1"],
};

describe("startup", () => {
  it("reports a trust dialog without answering it, and repeated start does not relaunch", async () => {
    const { adapter, requests } = await startupFixture("blocked");
    expect(await adapter.startAgent(startReq)).toEqual({
      agentName: "fixture-claude",
      paneId: "w3:p1",
      startup: "blocked",
    });
    expect(await adapter.startAgent(startReq)).toMatchObject({
      startup: "blocked",
    });
    expect(requests.filter((r) => r.method === "agent.start")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "pane.send_input")).toHaveLength(
      1,
    );
    expect(
      requests.find((r) => r.method === "agent.start")?.params.args,
    ).toEqual(startReq.args);
  });
  it("waits for interactive_ready even when screen state is unknown", async () => {
    const { adapter } = await startupFixture("ready");
    expect(await adapter.startAgent(startReq)).toMatchObject({
      startup: "ready",
    });
  });
  it("renames a timed-out resumed Codex only after exact native process evidence", async () => {
    const { adapter, requests } = await startupFixture("timeout", {
      startupTimeoutMs: 3001,
      pollMs: 100,
    });
    expect(
      await adapter.startAgent({
        ...startReq,
        kind: "codex",
        args: ["resume", "thread-1", "--remote", "unix:///private/socket"],
      }),
    ).toMatchObject({ startup: "readiness_timeout" });
    expect(requests.at(-1)).toMatchObject({
      method: "agent.rename",
      params: { target: "w3:p1", name: "fixture-claude" },
    });
  }, 6000);
  it("does not rename or retype when the resumed process is absent", async () => {
    const { adapter, requests } = await startupFixture("missing", {
      startupTimeoutMs: 3001,
      pollMs: 100,
    });
    await expect(
      adapter.startAgent({
        ...startReq,
        kind: "codex",
        args: ["resume", "thread-1", "--remote", "unix:///private/socket"],
      }),
    ).rejects.toMatchObject({ code: "startup_timeout" });
    expect(requests.some((r) => r.method === "agent.rename")).toBe(false);
  }, 6000);
  it("never types into an occupied pane", async () => {
    const { adapter, requests } = await setup((req) =>
      req.method === "agent.get"
        ? notFound
        : {
            result: {
              type: "pane_process_info",
              process_info: {
                pane_id: "w3:p1",
                shell_pid: 10,
                foreground_process_group_id: 20,
                foreground_processes: [{ pid: 20, name: "vim" }],
              },
            },
          },
    );
    await expect(adapter.startAgent(startReq)).rejects.toMatchObject({
      code: "shell_not_available",
    });
    expect(requests.some((r) => r.method === "pane.send_input")).toBe(false);
  });
});

it("lists recorded agents, including an unknown screen status", async () => {
  const { adapter } = await setup(() => fixture("agent-list", "/tmp"));
  const agents = await adapter.listAgents();
  expect(agents.map((agent) => agent.state)).toEqual([
    "unknown",
    "blocked",
    "idle",
  ]);
  expect(agents[0]?.agentSessionId).toBe("fixture-session");
});

it("does not expose a path-kind session reference as a provider session ID", async () => {
  const { adapter } = await setup(async () => {
    const response = (await fixture("agent-session", "/tmp")) as {
      result: {
        agent: {
          name?: string;
          agent_session: { kind: string; value: string };
        };
      };
    };
    delete response.result.agent.name;
    response.result.agent.agent_session = {
      ...response.result.agent.agent_session,
      kind: "path",
      value: "/private/session",
    };
    return response;
  });
  expect(await adapter.getAgent("w3:p1")).toMatchObject({
    name: "w3:p1",
    agentSessionId: null,
  });
});

it("maps successful prompt submission to ok without adding a wait", async () => {
  const { adapter, requests } = await setup(async () => {
    const response = (await fixture("agent-session", "/tmp")) as {
      result: { type: string };
    };
    response.result.type = "agent_prompted";
    return response;
  });
  expect(
    await adapter.prompt("fixture-claude", "plain text\nsecond line"),
  ).toBe("ok");
  expect(requests[0]?.params).toEqual({
    target: "fixture-claude",
    text: "plain text\nsecond line",
  });
});

it("uses the recorded reportSession acknowledgement", async () => {
  const { adapter } = await setup(() => fixture("report-session", "/tmp"));
  await expect(
    adapter.reportSession("w3:p1", "claude", "session-1" as ProviderSessionId),
  ).resolves.toBeUndefined();
});

it("refuses a conflicting named agent without touching its pane", async () => {
  const { adapter, requests } = await setup(() =>
    fixture("startup-blocked", "/tmp"),
  );
  await expect(
    adapter.startAgent({ ...startReq, paneId: "w99:p1" }),
  ).rejects.toMatchObject({ code: "agent_conflict" });
  expect(requests.map((req) => req.method)).toEqual(["agent.get"]);
});
