// Which agent CLI a pane is running, read from the process table rather than the screen. A
// pane's own process (an agent launched as the pane command) counts, then its descendants (an
// agent started from the pane's shell). This is a host fact about processes, never a status.
import { execFile } from "node:child_process";
import { basename } from "node:path";

export type AgentKind = "codex" | "claude";
export interface ProcessRow {
  pid: number;
  ppid: number;
  args: string;
}

/** Parses `ps -axo pid=,ppid=,args=` output. Malformed lines are skipped. */
export function parseProcesses(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      args: match[3] ?? "",
    });
  }
  return rows;
}

export function readProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,args="],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseProcesses(stdout)),
    );
  });
}

const kindOf = (args: string): AgentKind | null => {
  const words = args.trim().split(/\s+/);
  // `codex`, `/path/to/claude`, or `node /path/to/codex` (an npm shim).
  for (const word of words.slice(0, 2)) {
    const name = basename(word);
    if (name === "codex") return "codex";
    if (name === "claude") return "claude";
    if (name !== "node") break;
  }
  return null;
};

/** The agent running in the pane whose process is `pid`, searching the pane's process first. */
export function detectAgent(
  pid: number,
  processes: readonly ProcessRow[],
): AgentKind | null {
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const children = new Map<number, ProcessRow[]>();
  for (const row of processes) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const queue = [pid];
  const seen = new Set<number>();
  while (queue.length) {
    const current = queue.shift() as number;
    if (seen.has(current) || seen.size > 200) continue;
    seen.add(current);
    const row = byPid.get(current);
    if (row) {
      const kind = kindOf(row.args);
      if (kind) return kind;
    }
    for (const child of children.get(current) ?? []) queue.push(child.pid);
  }
  return null;
}
