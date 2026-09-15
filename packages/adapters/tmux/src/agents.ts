// Which agent CLI a pane is running, read from the process table rather than the screen. A
// pane's own process (an agent launched as the pane command) counts, then its descendants (an
// agent started from the pane's shell). This is a host fact about processes, never a status.
import { execFile } from "node:child_process";
import { basename } from "node:path";

type AgentKind = "codex" | "claude";
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

// Invocations of an agent binary that are not an interactive session: the coordinator's own
// `claude agents --json` poll, an app-server, a one-shot print. They must not tag a pane.
const NOT_A_SESSION: Record<AgentKind, ReadonlySet<string>> = {
  claude: new Set([
    "agents",
    "mcp",
    "config",
    "doctor",
    "update",
    "install",
    "login",
    "logout",
    "-p",
    "--print",
    "--version",
    "-v",
    "--help",
    "-h",
  ]),
  codex: new Set([
    "app-server",
    "exec",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "completion",
    "--version",
    "-V",
    "--help",
    "-h",
  ]),
};

const kindOf = (args: string): AgentKind | null => {
  const words = args.trim().split(/\s+/);
  // `codex`, `/path/to/claude`, or `node /path/to/codex` (an npm shim).
  for (const [index, word] of words.slice(0, 2).entries()) {
    const name = basename(word);
    const kind: AgentKind | null =
      name === "codex" ? "codex" : name === "claude" ? "claude" : null;
    if (kind) {
      const rest = words.slice(index + 1);
      return rest.some((arg) => NOT_A_SESSION[kind].has(arg)) ? null : kind;
    }
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
