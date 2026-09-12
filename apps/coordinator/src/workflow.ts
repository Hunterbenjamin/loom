// Design note 13.3, settled here: the repo's `WORKFLOW.md` is loaded and validated at the
// coordinator/MCP boundary, for the read-only `get_task_context` only. It is never a reconcile
// input and no guard depends on it, so a missing or malformed file must not stop a run.
//
// Policy:
//   - Location: `<repo root>/WORKFLOW.md`, read from the repository the task belongs to.
//   - Missing file: no commands. The agent is told the repo has none.
//   - Malformed file: no commands, and one warning. Half-parsed commands are worse than none,
//     because an agent would run them.
//   - Cache: keyed by absolute path, invalidated on size or mtime change, so editing the file
//     in a worktree takes effect without restarting the coordinator.

import { readFile, stat } from "node:fs/promises";
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

interface Entry {
  key: string;
  value: WorkflowCommands;
}

export interface WorkflowReader {
  read(repoRoot: string): Promise<WorkflowCommands>;
}

/** One reader per coordinator. `onWarning` receives a malformed file once per content change. */
export function createWorkflowReader(
  onWarning: (message: string) => void = () => {},
): WorkflowReader {
  const cache = new Map<string, Entry>();
  return {
    async read(repoRoot) {
      const path = join(repoRoot, WORKFLOW_FILE);
      let key: string;
      try {
        const info = await stat(path);
        key = `${info.size}:${info.mtimeMs}`;
      } catch {
        cache.delete(path);
        return {};
      }
      const cached = cache.get(path);
      if (cached?.key === key) return cached.value;
      let value: WorkflowCommands = {};
      try {
        value = parseWorkflow(await readFile(path, "utf8"));
      } catch (error) {
        onWarning(
          `${path} is malformed; no workflow commands are exposed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        value = {};
      }
      cache.set(path, { key, value });
      return value;
    },
  };
}
