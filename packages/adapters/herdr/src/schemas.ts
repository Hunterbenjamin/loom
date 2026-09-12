import { isAbsolute } from "node:path";
import { z } from "zod";

export const text = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\0"));
export const absolutePath = text.refine(isAbsolute);
export const agentName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const provider = z.enum(["claude", "codex"]);
export const state = z.enum(["working", "blocked", "idle", "done", "unknown"]);
export const session = z.object({
  source: text,
  agent: text,
  kind: z.enum(["id", "path"]),
  value: text,
});
export const agent = z.object({
  name: agentName.nullish(),
  pane_id: text,
  agent: text.nullish(),
  cwd: absolutePath.nullish(),
  foreground_cwd: absolutePath.nullish(),
  agent_status: state,
  agent_session: session.nullish(),
  launch_pending: z.boolean().optional(),
  interactive_ready: z.boolean().optional(),
});
export type Agent = z.infer<typeof agent>;
export const agentInfo = z.object({ type: z.literal("agent_info"), agent });
export const agentStarted = z.object({
  type: z.literal("agent_started"),
  agent,
  argv: z.array(text),
});
export const agentList = z.object({
  type: z.literal("agent_list"),
  agents: z.array(agent),
});
export const prompted = z.object({ type: z.literal("agent_prompted"), agent });
export const ok = z.object({ type: z.literal("ok") });
export const pane = z.object({
  pane_id: text,
  workspace_id: text,
  cwd: absolutePath.nullish(),
  foreground_cwd: absolutePath.nullish(),
});
export const paneList = z.object({
  type: z.literal("pane_list"),
  panes: z.array(pane),
});
export const workspaceCreated = z.object({
  type: z.literal("workspace_created"),
  workspace: z.object({ workspace_id: text }),
  root_pane: pane,
});
export const processInfo = z.object({
  type: z.literal("pane_process_info"),
  process_info: z.object({
    pane_id: text,
    shell_pid: z.number().int().positive().nullish(),
    foreground_process_group_id: z.number().int().positive().nullish(),
    foreground_processes: z
      .array(
        z.object({
          pid: z.number().int().positive(),
          name: text.nullish(),
          argv: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  }),
});
export const envelope = z.union([
  z
    .object({ id: text, result: z.unknown() })
    .strict()
    .refine((v) => "result" in v),
  z
    .object({ id: text, error: z.object({ code: text, message: z.string() }) })
    .strict(),
]);
// Only lifecycle events we subscribe to. Payloads are deliberately discarded, not state.
export const eventTypes = [
  "workspace.created",
  "workspace.updated",
  "workspace.closed",
  "pane.created",
  "pane.updated",
  "pane.closed",
  "pane.exited",
  "pane.agent_detected",
  "pane.moved",
] as const;
export const event = z
  .object({
    event: z.enum(eventTypes.map((type) => type.replaceAll(".", "_"))),
    data: z.object({ type: text }),
  })
  .refine((value) => value.data.type === value.event);
