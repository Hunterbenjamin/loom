import type { AckOutcome, Command } from "@loom/protocol";
import { command as commandSchema } from "@loom/protocol";
import { sendWithMergeNotification } from "./merge-notification.js";
import type { StoreContext } from "./store.js";

export function commandActions(ctx: StoreContext) {
  return {
    async command(value: Command): Promise<AckOutcome> {
      const parsed = commandSchema.safeParse(value);
      const sender = ctx.sender();
      const outcome: AckOutcome = !parsed.success
        ? {
            ok: false,
            error: {
              code: "invalid_input",
              message: "Check the command fields",
              details: [],
            },
          }
        : sender
          ? await sendWithMergeNotification(parsed.data, sender)
          : {
              ok: false,
              error: {
                code: "unavailable",
                message: ctx.live
                  ? "Disconnected; command was not sent"
                  : "Fixture mode: commands are not sent",
                details: [],
              },
            };
      ctx.toast(
        outcome.ok
          ? outcome.result.kind === "human"
            ? null
            : "Coordinator acknowledged the command."
          : `${outcome.error.code}: ${outcome.error.message}`,
      );
      return outcome;
    },
  };
}
