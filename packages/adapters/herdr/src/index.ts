import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  HerdrAdapter,
  HerdrAgentObservation,
  WorktreePath,
} from "@loom/core";
import { z } from "zod";
import { prepareShell } from "./launch.js";
import * as s from "./schemas.js";
import { HerdrError, HerdrSocket } from "./socket.js";

export { launchPrelude, scrubEnvironment } from "./launch.js";
export { HerdrError } from "./socket.js";

export interface HerdrOptions {
  /** Explicit local socket and matching named session; never inferred from HERDR_* or focus. */
  socketPath: string;
  sessionName: string;
  herdrExecutable?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollMs?: number;
  reconnectMs?: number;
  onError?: (error: HerdrError) => void;
}

const optionsSchema = z.object({
  socketPath: s.absolutePath,
  sessionName: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .refine((v) => v !== "default"),
  herdrExecutable: s.text.default("herdr"),
  startupTimeoutMs: z.number().int().min(3001).max(300000).default(8000),
  requestTimeoutMs: z.number().int().positive().default(15000),
  pollMs: z.number().int().positive().default(100),
  reconnectMs: z.number().int().positive().default(1000),
});

export function createHerdrAdapter(input: HerdrOptions): HerdrAdapter {
  const options = optionsSchema.parse(input);
  const socket = new HerdrSocket({ ...options, onError: input.onError });
  // Serialize mutations that share a pane/name and workspace creation in this adapter instance.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };
  async function rawAgent(target: string): Promise<s.Agent | null> {
    try {
      return (
        await socket.request(
          "agent.get",
          { target: s.text.parse(target) },
          s.agentInfo,
        )
      ).agent;
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_not_found")
        return null;
      throw error;
    }
  }
  async function observation(agent: s.Agent): Promise<HerdrAgentObservation> {
    const cwd = agent.foreground_cwd ?? agent.cwd;
    if (!cwd) throw new HerdrError("missing_cwd");
    return {
      name: agent.name ?? agent.pane_id,
      paneId: agent.pane_id,
      cwd: (await realpath(cwd)) as WorktreePath,
      state: agent.agent_status, // Screen-derived only. No run/stage decisions here.
      agentSessionId:
        agent.agent_session?.kind === "id" ? agent.agent_session.value : null,
    };
  }
  type Start = Parameters<HerdrAdapter["startAgent"]>[0];
  const ref = (
    req: Start,
    startup: "ready" | "blocked" | "readiness_timeout",
  ) => ({
    agentName: req.name,
    paneId: req.paneId,
    startup,
  });
  async function restoreName(req: Start) {
    let current: s.Agent | null;
    try {
      current = (
        await socket.request(
          "agent.rename",
          {
            target: req.paneId,
            name: req.name,
          },
          s.agentInfo,
        )
      ).agent;
    } catch (error) {
      // 0.9 refuses rename while launch_pending, even if the requested name is already set.
      if (
        !(error instanceof HerdrError) ||
        error.code !== "agent_launch_pending"
      )
        throw error;
      current = await rawAgent(req.paneId);
    }
    if (
      !current ||
      current.pane_id !== req.paneId ||
      current.name !== req.name ||
      (current.agent && current.agent !== req.kind)
    )
      throw new HerdrError("agent_conflict");
  }
  async function finishStart(
    req: Start,
  ): ReturnType<HerdrAdapter["startAgent"]> {
    const end = Date.now() + options.startupTimeoutMs;
    do {
      const current = await rawAgent(req.paneId);
      if (current) {
        if (
          current.pane_id !== req.paneId ||
          (current.name && current.name !== req.name) ||
          (current.agent && current.agent !== req.kind)
        )
          throw new HerdrError("agent_conflict");
        // These describe startup UI only; the provider still owns run status and delivery.
        if (current.agent_status === "blocked") {
          if (!current.name) await restoreName(req);
          return ref(req, "blocked");
        }
        if (current.interactive_ready && !current.launch_pending) {
          if (!current.name) await restoreName(req);
          return ref(req, "ready");
        }
      }
      await delay(options.pollMs);
    } while (Date.now() < end);
    // A timeout alone is not evidence of a live resumed TUI. Check native process argv.
    if (
      req.kind === "codex" &&
      req.args[0] === "resume" &&
      req.args[1] &&
      req.args.includes("--remote")
    ) {
      const { process_info: info } = await socket.request(
        "pane.process_info",
        { pane_id: req.paneId },
        s.processInfo,
      );
      const live =
        info.pane_id === req.paneId &&
        info.foreground_processes?.some((p) => {
          const argv = p.argv ?? [];
          return (
            p.pid !== info.shell_pid &&
            basename(argv[0] ?? "") === "codex" &&
            argv.length === req.args.length + 1 &&
            req.args.every((arg, i) => argv[i + 1] === arg)
          );
        });
      if (live) {
        await restoreName(req);
        return ref(req, "readiness_timeout");
      }
    }
    throw new HerdrError("startup_timeout");
  }

  return {
    openWorkspace(req) {
      return exclusive(async () => {
        const cwd = await realpath(s.absolutePath.parse(req.cwd));
        s.text.parse(req.label);
        if (!(await stat(cwd)).isDirectory())
          throw new HerdrError("cwd_not_directory");
        const { panes } = await socket.request("pane.list", {}, s.paneList);
        const matches = [];
        for (const pane of panes) {
          // cwd is the pane's shell cwd; foreground_cwd may temporarily point elsewhere.
          if (pane.cwd && (await realpath(pane.cwd).catch(() => null)) === cwd)
            matches.push(pane);
        }
        if (new Set(matches.map((p) => p.workspace_id)).size > 1)
          throw new HerdrError("ambiguous_workspace");
        const existing = matches[0];
        if (existing)
          return {
            workspaceId: existing.workspace_id,
            rootPaneId: existing.pane_id,
          };
        const result = await socket.request(
          "workspace.create",
          { cwd, label: req.label, focus: false },
          s.workspaceCreated,
        );
        if (result.root_pane.workspace_id !== result.workspace.workspace_id)
          throw new HerdrError("invalid_response");
        return {
          workspaceId: result.workspace.workspace_id,
          rootPaneId: result.root_pane.pane_id,
        };
      });
    },
    startAgent(req) {
      return exclusive(async () => {
        z.object({
          name: s.agentName,
          kind: s.provider,
          paneId: s.text,
          args: z.array(z.string().refine((v) => !v.includes("\0"))),
        }).parse(req);
        const named = await rawAgent(req.name);
        if (
          named &&
          (named.pane_id !== req.paneId ||
            (named.agent && named.agent !== req.kind))
        )
          throw new HerdrError("agent_conflict");
        if (!named) {
          const occupant = await rawAgent(req.paneId);
          if (occupant) {
            // Recover an interrupted start without typing another command into its process.
            if (
              occupant.agent !== req.kind ||
              (occupant.name && occupant.name !== req.name)
            ) {
              throw new HerdrError("agent_conflict");
            }
            return finishStart(req);
          }
          // No input is written unless native process metadata proves this is an available shell.
          await prepareShell(
            socket,
            req.paneId,
            req.kind,
            options.startupTimeoutMs,
          );
          try {
            const started = await socket.request(
              "agent.start",
              {
                name: req.name,
                kind: req.kind,
                pane_id: req.paneId,
                args: req.args,
                timeout_ms: options.startupTimeoutMs,
              },
              s.agentStarted,
            );
            if (
              started.agent.pane_id !== req.paneId ||
              started.agent.name !== req.name
            )
              throw new HerdrError("agent_conflict");
          } catch (error) {
            // Some versions wait server-side. Neither error authorizes a second launch or Enter.
            if (
              !(error instanceof HerdrError) ||
              !["agent_not_ready", "timeout"].includes(error.code)
            )
              throw error;
          }
        }
        return finishStart(req);
      });
    },
    async getAgent(name) {
      const agent = await rawAgent(name);
      return agent ? observation(agent) : null;
    },
    async listAgents() {
      const { agents } = await socket.request("agent.list", {}, s.agentList);
      return Promise.all(agents.map(observation));
    },
    async prompt(name, text) {
      s.text.parse(name);
      z.string().parse(text);
      if (/^\s*[/!]/u.test(text)) return "refused";
      try {
        await socket.request(
          "agent.prompt",
          { target: name, text },
          s.prompted,
        );
        return "ok";
      } catch (error) {
        if (!(error instanceof HerdrError)) throw error;
        switch (error.code) {
          case "agent_blocked":
            return "blocked";
          case "agent_prompt_stalled":
            return "stalled";
          case "agent_not_found":
            return "not_found";
          default:
            throw error;
        }
      }
    },
    async interrupt(name) {
      await socket.request(
        "agent.send_keys",
        { target: s.text.parse(name), keys: ["esc"] },
        s.ok,
      );
    },
    async reportSession(paneId, provider, sessionId) {
      await socket.request(
        "pane.report_agent_session",
        {
          pane_id: s.text.parse(paneId),
          source: `herdr:${s.provider.parse(provider)}`,
          agent: provider,
          agent_session_id: s.text.parse(sessionId),
          session_start_source: "resume",
        },
        s.ok,
      );
    },
    attachArgs(name) {
      return [
        options.herdrExecutable,
        "--session",
        options.sessionName,
        "agent",
        "attach",
        s.agentName.parse(name),
      ];
    },
    subscribe(onHint) {
      // A session-wide invalidation also covers deleted panes whose cwd can no longer be read.
      return socket.subscribe(() =>
        onHint({ source: "herdr", worktreePath: null, sessionId: null }),
      );
    },
  };
}
