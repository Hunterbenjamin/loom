// Narrow coordinator automation; native observations and the existing outbox own every action.
import type { Context } from "./context.js";
import { read } from "./helpers.js";
import { human } from "./human.js";

/** Exact repository commands may contain compositions. Built-in allowances never do. */
export function allowedImplementerCommand(
  command: string,
  workflow: Record<string, string>,
): boolean {
  if (Object.values(workflow).includes(command)) return true;
  if (/[\r\n;&|<>`$\\(){}]/.test(command)) return false;
  const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g);
  if (!words || words.join(" ") !== command.trim().replace(/ +/g, " "))
    return false;
  if (command === "pnpm install") return true;
  if (words[0] !== "git") return false;
  if (words[1] === "add")
    return (
      words.length > 2 &&
      words
        .slice(2)
        .map((word) =>
          word.startsWith('"') || word.startsWith("'")
            ? word.slice(1, -1)
            : word,
        )
        .every(
          (w) =>
            w === "--" ||
            w === "-A" ||
            w === "--all" ||
            w === "." ||
            (w.length > 0 &&
              !w.startsWith("-") &&
              !w.includes("..") &&
              !w.startsWith("/") &&
              !w.startsWith("~") &&
              !w.startsWith(":")),
        )
    );
  if (words[1] === "commit")
    return (
      words.length === 4 &&
      words[2] === "-m" &&
      /^("[^"\n]+"|'[^'\n]+')$/.test(words[3] ?? "")
    );
  return false;
}

export function automate(c: Context): void {
  const { state, observations } = c;
  for (const run of state.runs) {
    if (
      run.endedAt ||
      run.origin !== "loom" ||
      run.role !== "implementer" ||
      !run.launchedAt
    )
      continue;
    const provider = read(
      observations.runs.find((r) => r.runId === run.id)?.provider,
    );
    if (
      !provider ||
      (provider.provider === "codex"
        ? provider.threadId
        : provider.sessionId) !== run.sessionId
    )
      continue;
    const workflow = observations.workflowCommands ?? {};
    if (provider.provider === "codex") {
      for (const request of provider.pendingRequests) {
        if (
          request.kind !== "command_approval" ||
          !request.command ||
          !allowedImplementerCommand(request.command, workflow)
        )
          continue;
        human(
          c,
          {
            type: "answer_provider_request",
            runId: run.id,
            requestId: request.requestId,
            generation: provider.generation,
            decision: "accept",
            answers: null,
          },
          "automatic-permission",
        );
      }
    } else {
      const dialog = provider.hooks.pendingDialog;
      if (
        run.mode !== "interactive" ||
        !dialog ||
        dialog.kind !== "permission" ||
        dialog.tool !== "Bash" ||
        !dialog.requestId ||
        !dialog.command ||
        provider.agentsEntry?.status !== "waiting" ||
        !allowedImplementerCommand(dialog.command, workflow)
      )
        continue;
      human(
        c,
        {
          type: "answer_pane_prompt",
          runId: run.id,
          choice: 1,
          expectedDialog: {
            requestId: dialog.requestId,
            at: dialog.at,
            command: dialog.command,
            sessionEpoch: run.sessionEpoch,
          },
        },
        "automatic-permission",
      );
    }
  }
  const latest = state.runs.at(-1);
  const git = c.git;
  // A stale failure must not rescue a newer run. Remote ancestry is supplied by git;
  // a missing remote branch is publishable, while an unknown/diverged remote is not.
  if (
    latest?.origin === "loom" &&
    latest.mode === "interactive" &&
    latest.role === "implementer" &&
    observations.externalSessions.ok &&
    latest.endReason === "vanished" &&
    !state.desiredRun &&
    git?.headSha &&
    git.remoteHeadSha !== git.headSha &&
    (git.remoteHeadSha === null ||
      git.reachableCommits.includes(git.remoteHeadSha))
  ) {
    human(c, { type: "push_branch", headSha: git.headSha }, "automatic-rescue");
  }
  // Existing provider_input / run_vanished attention remains for the human. Never open a PR.
}
