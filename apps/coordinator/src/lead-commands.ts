import type { RepoId } from "@loom/core";
import type { Attachments } from "./attachments.js";
import { withAttachedFiles } from "./attachments.js";
import type { Handlers } from "./commands.js";
import type { ConversationViews } from "./conversations.js";
import type { LeadSession } from "./lead.js";

type LeadKind =
  | "open_lead_session"
  | "stop_lead_session"
  | "steer_lead_message"
  | "interrupt_lead"
  | "stage_attachment"
  | "send_lead_message"
  | "answer_lead_prompt";

interface LeadCommandDeps {
  lead(repoId: RepoId): LeadSession;
  attachments: Attachments;
  conversations: ConversationViews;
  publishLead(): Promise<void>;
  refreshInventory(): Promise<void>;
}

export function leadHandlers(deps: LeadCommandDeps): Handlers<LeadKind> {
  return {
    open_lead_session: async (command) => {
      const target = await deps.lead(command.repoId).open();
      await deps.publishLead();
      await deps.refreshInventory();
      return { ok: true, result: { kind: "attach_session", target } };
    },
    stop_lead_session: async (command) => {
      await deps.lead(command.repoId).stop();
      await deps.publishLead();
      return { ok: true, result: { kind: "lead_stopped" } };
    },
    steer_lead_message: async (command) => {
      const lead = deps.lead(command.repoId);
      const result = await lead.steerMessage(command.clientMessageId);
      deps.conversations.republish({ kind: "lead", repoId: command.repoId });
      deps.conversations.hint(lead.sessionId);
      return { ok: true, result: { kind: "lead_message", ...result } };
    },
    interrupt_lead: async (command) => {
      await deps.lead(command.repoId).interrupt();
      return { ok: true, result: { kind: "lead_interrupted" } };
    },
    stage_attachment: async (command) => {
      const attachment = await deps.attachments.stage(
        command.name,
        command.mediaType,
        command.dataBase64,
      );
      return {
        ok: true,
        result: { kind: "attachment_staged", ...attachment },
      };
    },
    send_lead_message: async (command) => {
      const lead = deps.lead(command.repoId);
      const attachments = await deps.attachments.resolve(
        command.attachmentIds ?? [],
      );
      const result = await lead.sendMessage(
        command.clientMessageId,
        withAttachedFiles(command.text, attachments),
        command.when ?? "now",
      );
      deps.conversations.republish({ kind: "lead", repoId: command.repoId });
      deps.conversations.hint(lead.sessionId);
      return { ok: true, result: { kind: "lead_message", ...result } };
    },
    answer_lead_prompt: async (command) => {
      const lead = deps.lead(command.repoId);
      await lead.answerPrompt(command.expectedDialog, command.choice);
      deps.conversations.hint(lead.sessionId);
      return { ok: true, result: { kind: "lead_prompt_answered" } };
    },
  };
}
