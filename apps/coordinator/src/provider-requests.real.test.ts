// Opt-in inference probe. Owns a private app-server, home, thread, and tmux server.
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createCodexAdapter,
  StaleCodexRequestError,
} from "@loom/adapter-codex";
import { createTmuxPaneHost } from "@loom/adapter-tmux";
import type { CodexThreadObservation, WorktreePath } from "@loom/core";
import { expect, test } from "vitest";
import { RpcConnection } from "../../../packages/adapters/codex/src/protocol.js";
import { turnResult } from "../../../packages/adapters/codex/src/schemas.js";
import {
  command,
  fixed,
  fixture,
} from "../../../packages/core/test/fixtures.js";

const exec = promisify(execFile);
const MODEL = "gpt-5.6-luna";

test.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "real interactive Codex accepts request two after request one is interrupted unanswered",
  async () => {
    const directory = await mkdtemp("/tmp/loom-approval-");
    const cwd = (await realpath(directory)) as WorktreePath;
    const instance = `test-${process.pid}-approval`;
    const codex = createCodexAdapter({ taskDirectory: directory });
    const host = createTmuxPaneHost({
      instance,
      configPath: join(directory, "tmux.conf"),
    });
    let rpc: RpcConnection | undefined;
    try {
      await codex.startServer();
      const allocated = await codex.startThread({
        cwd,
        model: MODEL,
        sandbox: "read-only",
        config: { model_reasoning_effort: "low" },
        developerInstructions:
          "You are an implementer in an isolated approval regression fixture. Execute only the exact requested harmless command. Do not spawn agents or use other tools.",
      });
      const f = fixture();
      const run = f.state.runs[1];
      if (!run) throw Error("Missing implementer");
      // Record the provider identity before launching the interactive attach process.
      run.sessionId = allocated.threadId;
      run.codexGeneration = allocated.generation;
      run.worktreePath = cwd;
      f.state.runs = [run];
      const workspace = await host.ensureWorkspace({
        taskId: f.state.task.id,
        cwd,
        label: "Approval regression",
      });
      const [executable, ...args] = codex.attachArgs(allocated.threadId);
      if (!executable) throw Error("Missing attach executable");
      run.pane = await host.ensurePane({
        workspaceId: workspace.workspaceId,
        runId: run.id,
        cwd,
        executable,
        args,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? directory,
          CODEX_HOME: join(directory, "codex-home"),
          TERM: "xterm-256color",
        },
      });
      expect((await host.getPane(run.pane))?.dead).toBe(false);
      ({ connection: rpc } = await RpcConnection.connect({
        socketPath: join(directory, "app-server.sock"),
        timeoutMs: 15000,
        onMessage: () => {},
        onDisconnect: () => {},
      }));
      const start = async (word: string) => {
        if (!rpc) throw Error("Missing probe connection");
        // Production launches use approvalPolicy=never. Override only this fixture's turn.
        return rpc.rpc(
          "turn/start",
          {
            threadId: allocated.threadId,
            model: MODEL,
            effort: "low",
            approvalPolicy: "untrusted",
            input: [
              {
                type: "text",
                text: `Run exactly this one shell command: python3 -c 'print("${word}")'. Then stop.`,
                text_elements: [],
              },
            ],
          },
          turnResult,
        );
      };
      const waitFor = async (
        check: (snapshot: CodexThreadObservation) => boolean,
      ) => {
        for (let i = 0; i < 180; i++) {
          const snapshot = await codex.readThread(allocated.threadId);
          if (check(snapshot)) return snapshot;
          if (snapshot.lastError) throw Error(snapshot.lastError.message);
          await delay(500);
        }
        throw Error("Timed out waiting for native approval state");
      };
      const observe = (value: CodexThreadObservation) => {
        f.observations.runs = [
          {
            runId: run.id,
            resumable: true,
            activityAt: null,
            readFailures: { resumable: null, activityAt: null },
            pane: null,
            provider: { ok: true, at: f.observations.now, value },
          },
        ];
      };
      const firstTurn = await start("approval-one");
      const first = await waitFor((s) => s.pendingRequests.length > 0);
      const firstId = first.pendingRequests[0]?.requestId;
      if (!firstId) throw Error("Missing first approval");
      observe(first);
      f.observations.inputs = [
        command(
          {
            type: "answer_provider_request",
            runId: run.id,
            generation: first.generation,
            requestId: firstId,
            decision: "accept",
            answers: null,
          },
          "first",
        ),
      ];
      let state = fixed(f.state, f.observations).next;
      const stale = state.outbox.find(
        (r) => r.kind === "answer_provider_request",
      );
      if (!stale) throw Error("Missing answer intent");
      stale.status = "running";
      stale.attempts = 1;
      // Retire the turn without ever answering approval one, then issue approval two.
      await codex.interruptTurn({
        threadId: allocated.threadId,
        turnId: firstTurn.turn.id,
      });
      await waitFor(
        (s) => s.pendingRequests.length === 0 && s.status === "idle",
      );
      await start("approval-two");
      const second = await waitFor((s) => s.pendingRequests.length > 0);
      const secondId = second.pendingRequests[0]?.requestId;
      expect(secondId).not.toBe(firstId);
      if (!secondId) throw Error("Missing second approval");
      await expect(
        codex.answerRequest({
          threadId: allocated.threadId,
          generation: first.generation,
          requestId: firstId,
          decision: "accept",
          answers: null,
        }),
      ).rejects.toThrow(StaleCodexRequestError);
      observe(second);
      f.observations.inputs = [
        command(
          {
            type: "answer_provider_request",
            runId: run.id,
            generation: second.generation,
            requestId: secondId,
            decision: "accept",
            answers: null,
          },
          "second",
        ),
      ];
      const result = fixed(state, f.observations);
      state = result.next;
      expect(state.outbox.find((r) => r.key === stale.key)?.status).toBe(
        "canceled",
      );
      const action = result.actions.find(
        (a) => a.kind === "answer_provider_request",
      );
      if (
        action?.kind !== "answer_provider_request" ||
        action.generation === null
      )
        throw Error("Missing current answer");
      await codex.answerRequest({
        ...action,
        threadId: allocated.threadId,
        generation: action.generation,
      });
      const completed = await waitFor(
        (s) => s.pendingRequests.length === 0 && s.status === "idle",
      );
      expect(completed.turns.at(-1)?.status).toBe("completed");
      observe(completed);
      f.observations.inputs = [];
      expect(
        fixed(state, f.observations).next.task.attention.reasons,
      ).not.toContain("provider_permission");
      console.info(
        `Codex interactive approval regression: ${firstId} -> ${secondId}; stale canceled; current accepted; turn completed.`,
      );
    } finally {
      rpc?.close();
      await exec("tmux", ["-L", `loom-${instance}`, "kill-server"]).catch(
        () => undefined,
      );
      await codex.stopServer();
      await rm(directory, { recursive: true, force: true });
    }
  },
  240_000,
);
