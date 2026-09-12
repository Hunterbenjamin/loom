import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider } from "@loom/core";
import { ok, processInfo } from "./schemas.js";
import { HerdrError, type HerdrSocket } from "./socket.js";

export function scrubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("CLAUDE_CODE_") &&
        !key.startsWith("HERDR_") &&
        key !== "CLAUDECODE",
    ),
  );
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Runs inside the pane, so this removes variables injected by Herdr as well as inherited ones.
// Bash indirect prefix expansion reads names only; values never appear in the terminal or logs.
export const scrubScript =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion, not JavaScript.
  'for loom_env_key in ${!CLAUDE_CODE_@} ${!HERDR_@} CLAUDECODE; do unset "$loom_env_key" || exit; done; exec "$@"';
export function launchPrelude(kind: Provider, marker: string): string {
  return `${kind}() { /usr/bin/env -u BASH_ENV /bin/bash --noprofile --norc -c ${quote(scrubScript)} loom-provider ${quote(kind)} "$@"; } && /usr/bin/touch ${quote(marker)}`;
}

export async function prepareShell(
  socket: HerdrSocket,
  paneId: string,
  kind: Provider,
  timeoutMs: number,
) {
  const read = async () =>
    (
      await socket.request(
        "pane.process_info",
        { pane_id: paneId },
        processInfo,
      )
    ).process_info;
  const info = await read();
  const shell = info.foreground_processes?.find(
    (p) => p.pid === info.shell_pid,
  );
  if (
    info.pane_id !== paneId ||
    !info.shell_pid ||
    info.foreground_process_group_id !== info.shell_pid ||
    info.foreground_processes?.length !== 1 ||
    !shell ||
    !["bash", "zsh"].includes(basename(shell.name ?? ""))
  ) {
    throw new HerdrError("shell_not_available");
  }
  const directory = await mkdtemp(join(tmpdir(), "loom-herdr-launch-"));
  const marker = join(directory, "ready");
  try {
    await socket.request(
      "pane.send_input",
      { pane_id: paneId, text: launchPrelude(kind, marker), keys: ["enter"] },
      ok,
    );
    const end = Date.now() + timeoutMs;
    do {
      let ready = false;
      try {
        await access(marker);
        ready = true;
      } catch {
        /* shell has not acknowledged */
      }
      if (ready) {
        const current = await read();
        if (
          current.shell_pid === info.shell_pid &&
          current.foreground_process_group_id === info.shell_pid
        )
          return;
      }
      await delay(25);
    } while (Date.now() < end);
    throw new HerdrError("shell_setup_timeout");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
