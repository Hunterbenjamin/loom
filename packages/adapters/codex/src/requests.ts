import type {
  CodexAdapter,
  CodexRequestObservation,
  IsoTime,
} from "@loom/core";
import { z } from "zod";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse.js";
import { type Incoming, type RpcConnection, redact } from "./protocol.js";
import * as schemas from "./schemas.js";

interface Pending {
  wireId: string | number;
  threadId: string;
  method: string;
  observation: CodexRequestObservation;
  availableDecisions?: unknown[] | null;
  questions?: string[];
  permissions?: z.infer<typeof schemas.permissionRequest>["permissions"];
  answered: boolean;
}
const requestId = z.union([z.string(), z.number().int()]);

/** Pending requests are connection-local; a response is not a resolution. */
export class PendingRequests {
  private readonly pending = new Map<string, Pending>();
  clear() {
    this.pending.clear();
  }
  forget(threadId: string) {
    for (const [key, pending] of this.pending)
      if (pending.threadId === threadId) this.pending.delete(key);
  }
  observe(threadId: string): CodexRequestObservation[] {
    return [...this.pending.values()]
      .filter((pending) => pending.threadId === threadId)
      .map((pending) => ({ ...pending.observation }));
  }
  receive(
    message: Incoming,
  ): { threadId: string; activityAt: IsoTime | null } | null {
    if (message.id !== undefined) {
      const base = {
        wireId: message.id,
        method: message.method,
        answered: false,
      };
      let pending: Pending;
      const observation = (
        threadId: string,
        kind: CodexRequestObservation["kind"],
        summary: string,
        isBlocking: boolean | null,
      ): Pending => ({
        ...base,
        threadId,
        observation: {
          requestId: String(message.id),
          kind,
          summary: redact(summary),
          isBlocking,
          receivedAt: new Date().toISOString() as IsoTime,
        },
      });
      switch (message.method) {
        case "item/commandExecution/requestApproval": {
          const params = schemas.commandRequest.parse(message.params);
          pending = {
            ...observation(
              params.threadId,
              "command_approval",
              params.command ??
                params.reason ??
                "Command execution requires approval",
              null,
            ),
            availableDecisions: params.availableDecisions,
          };
          break;
        }
        case "item/fileChange/requestApproval": {
          const params = schemas.fileRequest.parse(message.params);
          pending = observation(
            params.threadId,
            "file_approval",
            params.reason ?? "File change requires approval",
            null,
          );
          break;
        }
        case "item/permissions/requestApproval": {
          const params = schemas.permissionRequest.parse(message.params);
          pending = {
            ...observation(
              params.threadId,
              "permission",
              `Additional permissions: ${JSON.stringify(params.permissions)}`,
              null,
            ),
            permissions: params.permissions,
          };
          break;
        }
        case "item/tool/requestUserInput": {
          const params = schemas.questionRequest.parse(message.params);
          pending = {
            ...observation(
              params.threadId,
              "question",
              params.questions.map((q) => `${q.id}: ${q.question}`).join("\n"),
              params.isBlocking,
            ),
            questions: params.questions.map((q) => q.id),
          };
          break;
        }
        default:
          throw new Error("Unsupported Codex server request");
      }
      const key = String(message.id);
      const existing = this.pending.get(key);
      if (
        existing &&
        (existing.threadId !== pending.threadId ||
          existing.method !== pending.method ||
          existing.wireId !== pending.wireId)
      )
        throw new Error("Conflicting Codex request ID");
      if (!existing) {
        this.pending.set(key, pending);
      }
      const startedAtMs =
        z
          .object({
            startedAtMs: z
              .number()
              .finite()
              .nonnegative()
              .max(8_640_000_000_000_000)
              .optional(),
          })
          .parse(message.params).startedAtMs ?? message.emittedAtMs;
      return {
        threadId: pending.threadId,
        activityAt: existing
          ? null
          : startedAtMs === undefined
            ? pending.observation.receivedAt
            : (new Date(startedAtMs).toISOString() as IsoTime),
      };
    }
    if (message.method === "serverRequest/resolved") {
      const params = z
        .object({ threadId: schemas.identifier, requestId })
        .parse(message.params);
      const pending = this.pending.get(String(params.requestId));
      if (
        pending?.threadId === params.threadId &&
        pending.wireId === params.requestId
      )
        this.pending.delete(String(params.requestId));
      return { threadId: params.threadId, activityAt: null };
    }
    return null;
  }
  answer(
    req: Parameters<CodexAdapter["answerRequest"]>[0],
    connection: RpcConnection,
  ) {
    const pending = this.pending.get(req.requestId);
    if (!pending || pending.threadId !== req.threadId)
      throw new Error("No matching pending Codex request");
    if (pending.answered) return;
    let result:
      | CommandExecutionRequestApprovalResponse
      | FileChangeRequestApprovalResponse
      | ToolRequestUserInputResponse
      | PermissionsRequestApprovalResponse;
    switch (pending.observation.kind) {
      case "command_approval":
      case "file_approval":
        if (
          pending.availableDecisions &&
          !pending.availableDecisions.includes(req.decision)
        )
          throw new Error("Decision is not offered by Codex");
        result = { decision: req.decision };
        break;
      case "question": {
        const answers = z
          .record(z.string(), z.array(z.string()))
          .parse(req.answers ?? {});
        if (
          req.decision === "accept" &&
          pending.questions?.some((id) => !(id in answers))
        )
          throw new Error("Missing Codex question answers");
        if (Object.keys(answers).some((id) => !pending.questions?.includes(id)))
          throw new Error("Unknown Codex question ID");
        result = {
          answers: Object.fromEntries(
            (req.decision === "accept" ? Object.entries(answers) : []).map(
              ([id, answers]) => [id, { answers }],
            ),
          ),
        };
        break;
      }
      case "permission":
        result = {
          scope: "turn",
          permissions:
            req.decision === "accept"
              ? {
                  ...(pending.permissions?.network
                    ? { network: pending.permissions.network }
                    : {}),
                  ...(pending.permissions?.fileSystem
                    ? { fileSystem: pending.permissions.fileSystem }
                    : {}),
                }
              : {},
        };
        break;
    }
    connection.send({ id: pending.wireId, result });
    pending.answered = true;
    // Keep visible until serverRequest/resolved (another subscriber may win the response race).
  }
}
