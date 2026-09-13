// A terminal client sees only what the pane host draws after it attaches. Herdr keeps every
// pane in its own emulator with scrollback, so a selection can run up through history; Loom
// gets the same by reading the pane's history from the host on attach and replaying it into
// the viewer before the host's first redraw (docs/design/ui.md, "Terminals").
import { execFile } from "node:child_process";

export interface PaneHost {
  tmux: string;
  socket: string;
  paneId: string;
}

/** The host and pane behind an attach argv, or null when the argv is not a tmux attach. */
export function paneHostOf(
  argv: readonly string[],
  paneId: string | null | undefined,
): PaneHost | null {
  const [tmux, ...rest] = argv;
  const at = rest.indexOf("-L");
  const socket = at >= 0 ? rest[at + 1] : undefined;
  if (!tmux || !socket || !paneId) return null;
  return { tmux, socket, paneId };
}

function run(host: PaneHost, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      host.tmux,
      ["-L", host.socket, ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * The lines scrolled off the top of the pane, oldest first, with their colours, wrapped lines
 * joined, terminated by `\r\n`. Empty when there is no history.
 */
export async function readPaneHistory(
  host: PaneHost,
  limit: number,
): Promise<string> {
  const lines = Math.max(0, Math.min(200_000, Math.floor(limit)));
  if (lines === 0) return "";
  const raw = await run(host, [
    "capture-pane",
    "-p",
    "-e",
    "-J",
    "-S",
    `-${lines}`,
    "-E",
    "-1",
    "-t",
    host.paneId,
  ]);
  return historyText(raw);
}

/** `capture-pane -p` output as terminal input: one empty line means no history at all. */
export function historyText(raw: string): string {
  const trimmed = raw.replace(/\n+$/, "");
  if (trimmed === "") return "";
  return `${trimmed.replace(/\r?\n/g, "\r\n")}\x1b[m\r\n`;
}

/** Whether the pane's program is drawing on the alternate screen (a pager, an editor). */
export async function paneOnAlternateScreen(host: PaneHost): Promise<boolean> {
  const out = await run(host, [
    "display-message",
    "-p",
    "-t",
    host.paneId,
    "#{alternate_on}",
  ]);
  return out.trim() === "1";
}
