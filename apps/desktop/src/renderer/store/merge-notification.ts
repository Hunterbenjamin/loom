import type { AckOutcome, Command } from "@loom/protocol";

/** Command results follow the coordinator's owner refresh, not command submission. */
export async function sendWithMergeNotification(
  command: Command,
  send: (command: Command) => Promise<AckOutcome>,
): Promise<AckOutcome> {
  if (command.kind !== "merge_pull_request") return send(command);
  const id = `pr-merge:${crypto.randomUUID()}`;
  const notify = (title: string, body: string) => {
    // Native notification availability must never change a GitHub command's outcome.
    try {
      globalThis.window?.loomHost?.notify?.({
        id,
        title,
        body: body.slice(0, 8000),
      });
    } catch {
      /* The inline result remains available. */
    }
  };
  let outcome: AckOutcome;
  try {
    outcome = await send(command);
  } catch (error) {
    notify(
      "Pull request merge could not be confirmed",
      `PR #${command.number}: ${error instanceof Error ? error.message : "Connection lost"}. Refresh to check GitHub state.`,
    );
    throw error;
  }
  if (outcome.ok) {
    notify(
      "Pull request merged",
      `PR #${command.number} was squash-merged${command.deleteBranch ? " and its branch deleted" : ""}.`,
    );
  } else {
    notify(
      outcome.error.code === "unavailable"
        ? "Pull request merge could not be confirmed"
        : "Pull request merge failed",
      `PR #${command.number}: ${outcome.error.message}. Refresh to check GitHub state; the merge or branch deletion may have completed.`,
    );
  }
  return outcome;
}
