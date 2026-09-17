// Design note 13.3, settled here: the repo's `WORKFLOW.md` is loaded and validated at the
// coordinator/MCP boundary for `get_task_context` and exact implementer permission automation.
// Missing or malformed files expose no commands and never authorize a workflow allowance.
//
// Policy:
//   - Location: `<repo root>/WORKFLOW.md`, read from the repository the task belongs to.
//   - Missing file: no commands. The agent is told the repo has none.
//   - Malformed file: no commands, and one warning. Half-parsed commands are worse than none,
//     because an agent would run them.
//   - Cache: parsed results keyed by absolute path and content. Each read checks disk so even
//     same-size edits with preserved timestamps take effect immediately.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const WORKFLOW_FILE = "WORKFLOW.md";

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const commands = z
  .record(name, z.string().min(1).max(2000))
  .refine((v) => Object.keys(v).length <= 32, "too many commands");

export type WorkflowCommands = z.output<typeof commands>;

/**
 * A `## <name>` heading followed by a fenced block is one command. Anything else in the file is
 * prose for humans and is ignored. Duplicate names are a malformed file, not a last-one-wins.
 */
export function parseWorkflow(text: string): WorkflowCommands {
  const found: Record<string, string> = {};
  const pattern = /^##[ \t]+([^\n]+?)[ \t]*\n+```[^\n]*\n([\s\S]*?)\n?```/gm;
  for (const match of text.matchAll(pattern)) {
    const key = (match[1] ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    const body = (match[2] ?? "").trim();
    if (!body) continue;
    if (Object.hasOwn(found, key))
      throw new Error(`WORKFLOW.md defines ${key} twice`);
    found[key] = body;
  }
  return commands.parse(found);
}

export type WorkflowStatus =
  | { status: "present"; commands: WorkflowCommands }
  | { status: "missing"; commands: WorkflowCommands }
  | { status: "unusable"; commands: WorkflowCommands; reason: string };

export interface WorkflowReader {
  read(repoRoot: string): Promise<WorkflowCommands>;
  inspect(repoRoot: string): Promise<WorkflowStatus>;
}

/** One reader per coordinator; parsing and warnings share a single content cache. */
export function createWorkflowReader(
  onWarning: (message: string) => void = () => {},
): WorkflowReader {
  const cache = new Map<string, { text: string; value: WorkflowStatus }>();
  const inspect = async (repoRoot: string): Promise<WorkflowStatus> => {
    const path = join(repoRoot, WORKFLOW_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      cache.delete(path);
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "missing", commands: {} };
      return { status: "unusable", commands: {}, reason: String(error) };
    }
    const cached = cache.get(path);
    if (cached?.text === text) return cached.value;
    let value: WorkflowStatus;
    try {
      value = { status: "present", commands: parseWorkflow(text) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      value = { status: "unusable", commands: {}, reason };
      onWarning(
        `${path} is malformed; no workflow commands are exposed: ${reason}`,
      );
    }
    cache.set(path, { text, value });
    return value;
  };
  return {
    inspect,
    read: async (repoRoot) => (await inspect(repoRoot)).commands,
  };
}
