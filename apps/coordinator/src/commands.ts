import type {
  Command,
  ProtocolError,
  PullRequestCommand,
} from "@loom/protocol";
import { PreconditionFailed } from "./executor.js";

export type CommandResult =
  | { ok: true; result: unknown }
  | { ok: false; error: ProtocolError };

export type CommandOf<K extends Command["kind"]> = Extract<
  Command,
  { kind: K }
>;

export type Handlers<K extends Command["kind"] = Command["kind"]> = {
  [P in K]: (command: CommandOf<P>) => CommandResult | Promise<CommandResult>;
};

type PreparsedOrUnservedKind =
  | PullRequestCommand["kind"]
  | "fetch_pull_request_commit"
  | "fetch_pull_request_file"
  | "fetch_diff"
  | "save_review_state";

export type ServedCommandKind = Exclude<
  Command["kind"],
  PreparsedOrUnservedKind
>;

export async function dispatchCommand(
  command: Command,
  handlers: Partial<Handlers>,
): Promise<CommandResult> {
  try {
    const handler = handlers[command.kind] as
      | ((value: Command) => CommandResult | Promise<CommandResult>)
      | undefined;
    if (handler) return await handler(command);
    // The Workbench owns the diff and review-state requests; Phase 3 serves neither.
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: `${command.kind} is not served in this phase`,
        details: ["The Workbench and its diff view land in Phase 4"],
      },
    };
  } catch (error) {
    const typed = error as Error & { code?: string; details?: string[] };
    return {
      ok: false,
      error: {
        code:
          typed.code === "conflict"
            ? "conflict"
            : typed.code === "invalid_input"
              ? "invalid_input"
              : error instanceof PreconditionFailed
                ? "guard_failed"
                : "internal",
        message: error instanceof Error ? error.message : String(error),
        details: typed.details ?? [],
      },
    };
  }
}
