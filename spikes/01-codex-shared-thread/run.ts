// Small opt-in scenario driver; never invoked by npm test.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";
import { Client, redact, threadResult } from "./client.ts";

if (process.env.LOOM_REAL_PROVIDERS !== "1")
  throw new Error("Set LOOM_REAL_PROVIDERS=1");
const root = process.env.LOOM_SPIKE_ROOT;
if (!root?.endsWith("/loom-spike-01")) throw new Error("Set LOOM_SPIKE_ROOT");
const mode = z
  .enum(["approve", "decline", "hold", "tui", "detach", "crash", "read"])
  .parse(process.argv[2]);
const threadId = process.argv[3];
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
if (
  !threadId ||
  !z
    .array(z.string())
    .parse(JSON.parse(readFileSync(`${root}/owned-threads.json`, "utf8")))
    .includes(threadId)
)
  throw new Error("Thread not owned by this spike");
const client = await Client.connect(
  `${root}/codex.sock`,
  `${root}/logs/run-${mode}.jsonl`,
  `run-${mode}`,
);
const report = (value: unknown) => {
  const line = JSON.stringify(
    redact({
      at: new Date().toISOString(),
      mode,
      ...z.record(z.string(), z.unknown()).parse(value),
    }),
  );
  console.log(line);
  appendFileSync(`${root}/logs/scenarios.jsonl`, `${line}\n`, { mode: 0o600 });
};
try {
  await client.rpc(
    "thread/resume",
    { threadId, excludeTurns: true },
    threadResult,
  );
  if (
    mode === "approve" ||
    mode === "decline" ||
    mode === "hold" ||
    mode === "tui"
  ) {
    const since = client.messages.length;
    const turn = await client.rpc(
      "turn/start",
      {
        threadId,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        input: [
          {
            type: "text",
            text: `Use exec_command to run printf APPROVAL_${mode.toUpperCase()} with sandbox_permissions=require_escalated and justification asking approval. This is a harmless approval test. If declined, stop without retrying.`,
            text_elements: [],
          },
        ],
      },
      z.object({ turn: z.object({ id: z.string() }) }),
    );
    const request = await client.waitFor(
      "item/commandExecution/requestApproval",
      since,
    );
    report({ request });
    if (mode === "hold") {
      const late = await Client.connect(
        `${root}/codex.sock`,
        `${root}/logs/late-approval.jsonl`,
        "late-approval",
      );
      try {
        const resumed = await late.rpc(
          "thread/resume",
          { threadId, excludeTurns: true },
          threadResult,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        report({
          lateSubscriber: {
            status: resumed.thread.status,
            pending: [...late.requests.keys()],
          },
        });
      } finally {
        late.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 30000));
      report({
        after30Seconds: await client.rpc(
          "thread/read",
          { threadId },
          threadResult,
        ),
        pending: [...client.requests.keys()],
      });
      await client.rpc(
        "turn/interrupt",
        { threadId, turnId: turn.turn.id },
        z.object({}),
      );
    } else if (mode !== "tui") {
      client.respond(z.union([z.string(), z.number()]).parse(request.id), {
        decision: mode === "approve" ? "accept" : "decline",
      });
    }
    report({
      completion: await client.waitFor("turn/completed", since),
      pending: [...client.requests.keys()],
    });
  } else if (mode === "detach") {
    const herdr = (...args: string[]) => {
      const output = execFileSync("herdr", args, { encoding: "utf8" });
      report({ command: ["herdr", ...args], output });
      return output;
    };
    const created = z
      .object({
        result: z.object({ root_pane: z.object({ pane_id: z.string() }) }),
      })
      .parse(
        JSON.parse(
          herdr(
            "tab",
            "create",
            "--workspace",
            z.string().parse(process.env.HERDR_WORKSPACE_ID),
            "--cwd",
            `${root}/repo`,
            "--label",
            "spike-01-detach",
            "--no-focus",
          ),
        ),
      );
    const pane = created.result.root_pane.pane_id;
    let open = true;
    try {
      const command = `CODEX_HOME=${shellQuote(`${root}/home`)} codex resume ${shellQuote(threadId)} --remote ${shellQuote(`unix://${root}/tui.sock`)} -C ${shellQuote(`${root}/repo`)} -c 'model="gpt-5.6-luna"' --no-alt-screen`;
      herdr("pane", "run", pane, command);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const since = client.messages.length;
      const turn = await client.rpc(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: "Run sleep 45 in the shell and wait for it, then reply DETACH_DONE. No other tools.",
              text_elements: [],
            },
          ],
        },
        z.object({ turn: z.object({ id: z.string() }) }),
      );
      await client.waitFor(
        "item/started",
        since,
        45000,
        (m) =>
          "method" in m &&
          z.object({ item: z.object({ type: z.string() }) }).parse(m.params)
            .item.type === "commandExecution",
      );
      report({
        beforeDetach: (
          await client.rpc("thread/read", { threadId }, threadResult)
        ).thread.status,
        turnId: turn.turn.id,
      });
      report({ tuiDisplay: herdr("pane", "read", pane, "--lines", "14") });
      herdr("pane", "close", pane);
      open = false;
      report({
        afterTuiClose: (
          await client.rpc("thread/read", { threadId }, threadResult)
        ).thread.status,
      });
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const reconnect = await Client.connect(
        `${root}/codex.sock`,
        `${root}/logs/reconnect.jsonl`,
        "reconnect",
      );
      try {
        const result = await reconnect.rpc(
          "thread/resume",
          { threadId },
          threadResult,
        );
        report({
          afterNoSubscribers: result.thread.status,
          turns: result.thread.turns.map((t) => ({
            id: t.id,
            status: t.status,
          })),
        });
        report({
          completion: await reconnect.waitFor("turn/completed", 0, 60000),
        });
      } finally {
        reconnect.close();
      }
    } finally {
      if (open) herdr("pane", "close", pane);
    }
  } else if (mode === "crash") {
    const pane = z
      .string()
      .regex(/^w[0-9]+:p[0-9]+$/)
      .parse(process.env.LOOM_SPIKE_SERVER_PANE);
    const info = z
      .object({
        result: z.object({
          process_info: z.object({
            foreground_processes: z.array(
              z.object({
                pid: z.number().int().positive(),
                argv: z.array(z.string()),
                name: z.string(),
              }),
            ),
          }),
        }),
      })
      .parse(
        JSON.parse(
          execFileSync("herdr", ["pane", "process-info", "--pane", pane], {
            encoding: "utf8",
          }),
        ),
      );
    const server = info.result.process_info.foreground_processes.find(
      (p) =>
        p.name === "codex" &&
        p.argv.includes("app-server") &&
        p.argv.includes(`unix://${root}/codex.sock`),
    );
    if (!server)
      throw new Error(
        "Refusing to kill: no matching private server in the specified pane",
      );
    const since = client.messages.length;
    const started = await client.rpc(
      "turn/start",
      {
        threadId,
        input: [
          {
            type: "text",
            text: "Say CRASH_BEGIN, then run sleep 45 and wait, then reply CRASH_END. No other tools.",
            text_elements: [],
          },
        ],
      },
      z.object({ turn: z.object({ id: z.string() }) }),
    );
    await client.waitFor(
      "item/started",
      since,
      45000,
      (m) =>
        "method" in m &&
        z.object({ item: z.object({ type: z.string() }) }).parse(m.params).item
          .type === "commandExecution",
    );
    report({
      beforeKill: (await client.rpc("thread/read", { threadId }, threadResult))
        .thread.status,
      turnId: started.turn.id,
      privateServerPid: server.pid,
    });
    process.kill(server.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    report({
      afterKillSocketState: client.ws.readyState,
      receivedCompletion: client.messages
        .slice(since)
        .some((m) => "method" in m && m.method === "turn/completed"),
    });
    execFileSync(
      "herdr",
      ["pane", "run", pane, `sh ${shellQuote(`${root}/server.sh`)}`],
      {
        encoding: "utf8",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fresh = await Client.connect(
      `${root}/codex.sock`,
      `${root}/logs/recovery.jsonl`,
      "recovery",
    );
    try {
      const read = await fresh.rpc(
        "thread/read",
        { threadId, includeTurns: true },
        threadResult,
      );
      report({
        diskRead: {
          status: read.thread.status,
          lastTurn: read.thread.turns.at(-1),
        },
      });
      const resumed = await fresh.rpc(
        "thread/resume",
        { threadId },
        threadResult,
      );
      report({
        resumed: {
          status: resumed.thread.status,
          lastTurn: resumed.thread.turns.at(-1),
        },
      });
      const cursor = fresh.messages.length;
      await fresh.rpc(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: "Reply RECOVERED. No tools.",
              text_elements: [],
            },
          ],
        },
        z.object({ turn: z.object({ id: z.string() }) }),
      );
      report({ completion: await fresh.waitFor("turn/completed", cursor) });
    } finally {
      fresh.close();
    }
  } else if (mode === "read") {
    const r = await client.rpc(
      "thread/read",
      { threadId, includeTurns: true },
      threadResult,
    );
    report({
      threadId,
      status: r.thread.status,
      turns: r.thread.turns.map((t) => ({
        id: t.id,
        status: t.status,
        items: t.items,
      })),
    });
  } else throw new Error("Unknown scenario");
} finally {
  client.close();
}
