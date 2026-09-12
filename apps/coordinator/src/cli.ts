#!/usr/bin/env node
// `loom`. Everything except `serve`, `repo add` and `task inspect` is a protocol client: it connects, takes a
// snapshot, sends a command and prints the acknowledgement. It holds no state of its own.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  HumanCommand,
  ProviderRules,
  RepoId,
  Sha,
  TaskId,
} from "@loom/core";
import type { Command, Subscription } from "@loom/protocol";
import { openReadOnlyStore, openStore } from "@loom/store";
import { LoomClient } from "./client.js";
import {
  type CoordinatorConfig,
  configFromEnvironment,
  reconcileConfig,
} from "./config.js";
import { Coordinator } from "./coordinator.js";
import { formatInspection, getTaskTimings, inspectTask } from "./inspect.js";
import { createRealAdapters } from "./real-adapters.js";

const USAGE = `loom — Loom's coordinator and its client

  loom serve                            run the coordinator for this instance
  loom operator status [--json]         Operator session, queue, actions and quota
  loom status                           what every task is doing
  loom repo add <root> <owner/name>     register a repository with this instance
  loom task create <repo> <title> [description] [--small]
  loom task list [--view needs_you]
  loom task show <task>
  loom task inspect <task> [--json]     read persisted diagnostics without a coordinator
  loom task move <task> backlog|todo
  loom task approve-plan <task> <planVersion>
  loom task reject-plan <task> <feedback>
  loom task approve <task> <headSha>
  loom task request-changes <task> <title> <body>
  loom task answer <task> <questionId> <answer>
  loom task answer-request <task> <runId> <requestId> accept|decline|cancel
  loom task retry <task>
  loom task cancel <task> <reason>
  loom task timings <task>               show per-stage durations from transitions
  loom attach <task> [role] [--exec]    print, or run, the pane host's attach command

Environment: LOOM_INSTANCE, LOOM_DATA_ROOT, LOOM_TOKEN, LOOM_BIND, LOOM_WORKTREE_ROOT.`;

const flag = (argv: string[], name: string): string | null => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};
const has = (argv: string[], name: string): boolean =>
  argv.includes(`--${name}`);
const rest = (argv: string[]): string[] => {
  const booleanFlags = new Set([
    "--json",
    "--small",
    "--require-plan-approval",
  ]);
  return argv.filter((value, index) => {
    if (value.startsWith("--")) return false;
    const prevFlag = argv[index - 1];
    if (!prevFlag?.startsWith("--")) return true;
    return booleanFlags.has(prevFlag);
  });
};

const connect = async (
  config: CoordinatorConfig,
  subscriptions: Subscription[] = [],
): Promise<LoomClient> =>
  LoomClient.connect({
    url: `ws://${config.bind.host}:${config.bind.port}`,
    token: config.token,
    clientId: `cli-${randomUUID().slice(0, 8)}`,
    kind: "cli",
    subscriptions,
    onError: (message) => process.stderr.write(`${message}\n`),
  });

/** Every command answers with exactly one ack; a rejection reads the same as an agent's would. */
async function send(
  config: CoordinatorConfig,
  command: Command,
): Promise<void> {
  const client = await connect(config);
  try {
    const outcome = await client.command(command);
    if (!outcome.ok) {
      process.stderr.write(
        `${outcome.error.code}: ${outcome.error.message}\n${outcome.error.details
          .map((line) => `  ${line}\n`)
          .join("")}`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  } finally {
    client.close();
  }
}

const humanCommand = (
  config: CoordinatorConfig,
  taskId: TaskId,
  command: HumanCommand,
) => send(config, { kind: "human", taskId, command });

async function status(
  config: CoordinatorConfig,
  view: string | null,
): Promise<void> {
  const client = await connect(
    config,
    view
      ? [{ kind: "views", views: [view as "needs_you"], repoIds: null }]
      : [],
  );
  try {
    const tasks = [...(client.state?.collections.task.values() ?? [])];
    if (!tasks.length) {
      process.stdout.write("No tasks.\n");
      return;
    }
    for (const task of tasks.sort((a, b) => (a.id < b.id ? -1 : 1)))
      process.stdout.write(
        `${task.id}  ${task.stage.padEnd(18)} ${
          task.attention.reasons.join(",") || "-"
        }  ${task.title}\n`,
      );
  } finally {
    client.close();
  }
}

async function show(config: CoordinatorConfig, taskId: TaskId): Promise<void> {
  const client = await connect(config, [{ kind: "task", taskId }]);
  try {
    const task = client.state?.collections.task.get(taskId);
    if (!task) {
      process.stderr.write(`unknown_task: ${taskId}\n`);
      process.exitCode = 1;
      return;
    }
    const runs = [...(client.state?.collections.run.values() ?? [])].filter(
      (r) => r.taskId === taskId,
    );
    const findings = [
      ...(client.state?.collections.finding.values() ?? []),
    ].filter((f) => f.taskId === taskId);
    process.stdout.write(
      `${task.id}  ${task.title}\n  stage: ${task.stage}\n  branch: ${task.branch ?? "-"}\n` +
        `  pr: ${task.prNumber ?? "-"}\n  attention: ${
          task.attention.reasons.join(",") || "-"
        }\n  blocked: ${task.blocked?.reason ?? "-"}\n  failed: ${
          task.failed?.reason ?? "-"
        }\n`,
    );
    for (const run of runs)
      process.stdout.write(
        `  run ${run.id} ${run.role}/${run.provider}/${run.mode} ${run.status}${
          run.endReason ? ` (${run.endReason})` : ""
        }\n`,
      );
    for (const finding of findings)
      process.stdout.write(
        `  finding ${finding.id} ${finding.severity} ${finding.status} ${finding.title}\n`,
      );
  } finally {
    client.close();
  }
}

/** Prints the pane host's argv, or runs it. No takeover: the host allows many clients at once. */
async function attach(
  config: CoordinatorConfig,
  taskId: TaskId,
  role: string,
  exec: boolean,
): Promise<void> {
  const client = await connect(config, [{ kind: "task", taskId }]);
  try {
    const run = [...(client.state?.collections.run.values() ?? [])]
      .filter((r) => r.taskId === taskId && r.role === role && !r.endedAt)
      .at(-1);
    if (!run) {
      process.stderr.write(`unknown_run: no live ${role} run for ${taskId}\n`);
      process.exitCode = 1;
      return;
    }
    const outcome = await client.command({
      kind: "open_attach_session",
      runId: run.id,
    });
    if (!outcome.ok || outcome.result.kind !== "attach_session") {
      process.stderr.write(
        `${outcome.ok ? "internal" : outcome.error.code}: no attach target\n`,
      );
      process.exitCode = 1;
      return;
    }
    const target = outcome.result.target;
    if (!target.attach) {
      process.stderr.write("unavailable: this run has no pane\n");
      process.exitCode = 1;
      return;
    }
    const [executable, ...args] = target.attach.argv;
    if (!exec || !executable) {
      process.stdout.write(`${target.attach.argv.join(" ")}\n`);
      return;
    }
    client.close();
    const child = spawn(executable, args, { stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  } finally {
    client.close();
  }
}

async function serve(config: CoordinatorConfig): Promise<void> {
  const store = await openStore({
    dataRoot: config.dataRoot,
    instance: config.instance,
    config: reconcileConfig(config),
  });
  const adapters = await createRealAdapters(config, store, (error) =>
    process.stderr.write(`adapter: ${error.message}\n`),
  );
  const coordinator = new Coordinator({
    config,
    store,
    adapters,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  const report = await coordinator.start();
  coordinator.run();
  process.stderr.write(
    `loom ${config.instance} listening on ${coordinator.protocol.url}; mcp on ${coordinator.mcpUrl}\n` +
      `recovered: ${report.recorded.length} recorded, ${report.requeued.length} requeued, ` +
      `${report.resumedCodex.length} Codex threads resumed, ${report.relaunched.length} panes relaunched\n` +
      `codex app-servers: ${adapters.codexServerCount()}\n`,
  );
  // Periodically log app-server count for observability
  const serverCountInterval = setInterval(() => {
    const count = adapters.codexServerCount();
    if (count > 0) process.stderr.write(`codex app-servers: ${count}\n`);
  }, 60000); // Every 60 seconds
  serverCountInterval.unref?.();
  const stop = () => {
    clearInterval(serverCountInterval);
    void coordinator.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

async function addRepo(
  config: CoordinatorConfig,
  root: string,
  github: string,
  baseBranch: string,
): Promise<void> {
  // An instance-local admin write, like `serve` itself: the protocol carries no repo registry.
  const store = await openStore({
    dataRoot: config.dataRoot,
    instance: config.instance,
    config: reconcileConfig(config),
  });
  try {
    const path = await (await import("node:fs/promises")).realpath(root);
    const id = github.replace("/", "-") as RepoId;
    store.putRepo({
      id,
      root: path as never,
      github,
      baseBranch,
      defaultProviders: {
        planner: "claude",
        implementer: "claude",
        reviewer: "codex",
      } satisfies ProviderRules,
      serialTests: false,
    });
    process.stdout.write(`${id}\n`);
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  const positional = rest(argv);
  const [group, ...args] = positional;
  if (!group || group === "help" || has(argv, "help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const config = configFromEnvironment();
  if (group === "operator") {
    if (args[0] !== "status") throw new Error("loom operator status [--json]");
    const client = await connect(config);
    try {
      const state = client.state?.collections.operator.get("operator");
      process.stdout.write(
        has(argv, "json")
          ? `${JSON.stringify(state ?? null, null, 2)}\n`
          : state
            ? `Operator: ${state.status}\nQueue: ${state.queueLength}\nFiled this hour: ${state.filedThisHour}\n${state.actions.map((a) => `${a.at} ${a.outcome}: ${a.body}`).join("\n")}\n${state.escalation ?? state.error ?? ""}\n`
            : "Operator unavailable\n",
      );
    } finally {
      client.close();
    }
    return;
  }
  if (group === "serve") return serve(config);
  if (group === "status") return status(config, flag(argv, "view"));
  if (group === "attach") {
    const [taskId, role] = args;
    if (!taskId) throw new Error("loom attach needs a task");
    return attach(
      config,
      taskId as TaskId,
      role ?? "implementer",
      has(argv, "exec"),
    );
  }
  if (group === "repo") {
    const [action, root, github] = args;
    if (action !== "add" || !root || !github)
      throw new Error("loom repo add <root> <owner/name>");
    return addRepo(
      config,
      root,
      github,
      flag(argv, "base") ?? config.baseBranch,
    );
  }
  if (group !== "task") throw new Error(`Unknown command ${group}\n\n${USAGE}`);
  const [action, ...values] = args;
  const taskId = values[0] as TaskId;
  switch (action) {
    case "create": {
      const [repoId, title, description] = values;
      if (!repoId || !title) throw new Error("loom task create <repo> <title>");
      return send(config, {
        kind: "create_task",
        repoId: repoId as RepoId,
        title,
        description: description ?? "",
        providers: null,
        requirePlanApproval: has(argv, "require-plan-approval") ? true : null,
        blockedBy: [],
        budgetMinutes: null,
        size: has(argv, "small") ? "small" : null,
      });
    }
    case "list":
      return status(config, flag(argv, "view"));
    case "inspect": {
      if (!taskId) throw new Error("loom task inspect <task> [--json]");
      const store = openReadOnlyStore({
        dataRoot: config.dataRoot,
        instance: config.instance,
        config: reconcileConfig(config),
      });
      try {
        if (!store.tasks().some((task) => task.id === taskId)) {
          process.stderr.write(`unknown_task: ${taskId}\n`);
          process.exitCode = 1;
          return;
        }
        const data = inspectTask(store, taskId);
        process.stdout.write(
          has(argv, "json")
            ? `${JSON.stringify(data, null, 2)}\n`
            : formatInspection(data),
        );
      } finally {
        store.close();
      }
      return;
    }
    case "timings": {
      if (!taskId) throw new Error("loom task timings <task>");
      const store = openReadOnlyStore({
        dataRoot: config.dataRoot,
        instance: config.instance,
        config: reconcileConfig(config),
      });
      try {
        if (!store.tasks().some((task) => task.id === taskId)) {
          process.stderr.write(`unknown_task: ${taskId}\n`);
          process.exitCode = 1;
          return;
        }
        const timings = getTaskTimings(store, taskId);
        if (timings.stageTimings.length === 0) {
          process.stdout.write(`${timings.message}\n`);
          return;
        }

        const lines: string[] = [];
        lines.push(`Task: ${taskId}`);
        if (timings.totalDuration !== null) {
          lines.push(
            `Total duration: ${(timings.totalDuration / 1000 / 60).toFixed(2)} minutes`,
          );
        }
        lines.push("");
        lines.push("Stage transitions:");

        for (const timing of timings.stageTimings) {
          const durationSec = (timing.duration / 1000).toFixed(2);
          const durationMin = (timing.duration / 1000 / 60).toFixed(2);
          lines.push(
            `  ${timing.from} → ${timing.to}: ${durationSec}s (${durationMin}min) at ${timing.at}`,
          );
        }

        process.stdout.write(`${lines.join("\n")}\n`);
      } finally {
        store.close();
      }
      return;
    }
    case "show":
      return show(config, taskId);
    case "move":
      return humanCommand(config, taskId, {
        type: "move",
        to: values[1] === "backlog" ? "backlog" : "todo",
      });
    case "approve-plan":
      return humanCommand(config, taskId, {
        type: "approve_plan",
        planVersion: Number(values[1]),
      });
    case "reject-plan":
      return humanCommand(config, taskId, {
        type: "reject_plan",
        feedback: values.slice(1).join(" "),
      });
    case "approve":
      return humanCommand(config, taskId, {
        type: "approve",
        headSha: values[1] as Sha,
      });
    case "request-changes":
      return humanCommand(config, taskId, {
        type: "request_changes",
        findings: [
          {
            id: `${taskId}/human/${randomUUID().slice(0, 8)}` as never,
            severity: "major",
            title: values[1] ?? "Requested changes",
            body: values.slice(2).join(" "),
            anchor: null,
          },
        ],
      });
    case "answer":
      return humanCommand(config, taskId, {
        type: "answer_question",
        questionId: values[1] as never,
        answer: values.slice(2).join(" "),
      });
    case "answer-request": {
      const [runId, requestId, decision] = values.slice(1);
      if (!runId || !requestId || !decision)
        throw new Error(
          "loom task answer-request <task> <runId> <requestId> accept|decline|cancel",
        );
      if (!["accept", "decline", "cancel"].includes(decision)) {
        throw new Error("decision must be accept, decline, or cancel");
      }
      // Connect to coordinator to read the run's snapshot and get codexGeneration
      const client = await connect(config, [
        { kind: "task", taskId },
        { kind: "run", runId: runId as never },
      ]);
      try {
        const run = [...(client.state?.collections.run.values() ?? [])].find(
          (r) => r.id === runId,
        );
        if (!run) {
          process.stderr.write(`unknown_run: ${runId}\n`);
          process.exitCode = 1;
          return;
        }
        client.close();
        return humanCommand(config, taskId, {
          type: "answer_provider_request",
          runId: runId as never,
          requestId,
          generation: run.codexGeneration,
          decision: decision as "accept" | "decline" | "cancel",
          answers: null,
        });
      } finally {
        client.close();
      }
    }
    case "retry":
      return humanCommand(config, taskId, { type: "retry" });
    case "cancel":
      return humanCommand(config, taskId, {
        type: "cancel",
        reason: values.slice(1).join(" ") || "cancelled from the CLI",
      });
    default:
      throw new Error(`Unknown task command ${action}\n\n${USAGE}`);
  }
}

if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("loom"))
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
