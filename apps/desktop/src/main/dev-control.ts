import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type DevControlCommand, devControlCommand } from "../shared/ipc.js";

const EXIT_MARKER = "dev-control-exit";
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** What the human should read after `dev.sh sync` finished without restarting this app. */
export function syncSummary(output: string): { title: string; detail: string } {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const exit = lines.find((line) => line.startsWith(EXIT_MARKER));
  const report = lines.filter((line) => !line.startsWith(EXIT_MARKER));
  const detail = report.join("\n");
  if (exit !== `${EXIT_MARKER} 0`) return { title: "Update failed", detail };
  const update = report.find((line) => line.startsWith("update:"));
  if (update && !update.includes(" -> "))
    return { title: "Loom couldn't update to the latest main", detail };
  if (update) return { title: "Loom updated", detail };
  return { title: "Loom is up to date", detail };
}

export function devControls(
  appPath: string,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv,
) {
  // In development app.getAppPath() is this checkout's apps/desktop directory.
  const root = resolve(appPath, "../..");
  const available = () =>
    !isPackaged && existsSync(join(root, "scripts/dev.sh"));
  const launch = (command: DevControlCommand, report?: string) => {
    if (!available()) throw new Error("Dev controls are unavailable");
    const instance = env.LOOM_INSTANCE ?? "dev";
    const args = [
      "-L",
      `loom-${instance}`,
      "new-session",
      "-d",
      "-s",
      `dev-control-${Date.now()}`,
      "-c",
      root,
      "-e",
      `LOOM_INSTANCE=${instance}`,
    ];
    // A running tmux server may have an older environment than this app.
    for (const key of [
      "LOOM_DATA_ROOT",
      "LOOM_TMUX_BIN",
      "LOOM_BIND_PORT",
      "LOOM_MCP_PORT",
      "LOOM_HOOK_PORT",
    ]) {
      if (env[key] !== undefined) args.push("-e", `${key}=${env[key]}`);
    }
    const script = `scripts/dev.sh ${command.replace("-", " ")}`;
    args.push(
      report
        ? `${script} > ${shellQuote(report)} 2>&1; echo "${EXIT_MARKER} $?" >> ${shellQuote(report)}`
        : script,
    );
    return new Promise<void>((resolve, reject) => {
      // tmux owns the script; neither its session nor the launcher is an Electron PTY.
      const child = spawn(env.LOOM_TMUX_BIN ?? "tmux", args, {
        cwd: root,
        env,
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Dev control launcher exited (${code})`));
      });
      child.unref();
    });
  };
  return {
    available,
    run(raw: unknown): Promise<void> {
      return launch(devControlCommand.parse(raw));
    },
    /** Runs the command with its output in `report`, resolving with it once the script ends. If the
     * script restarts this app, the process ends first and nothing resolves, which is the point. */
    async runAndReport(
      command: DevControlCommand,
      report: string,
      pollMs = 500,
      timeoutMs = 10 * 60_000,
    ): Promise<string> {
      rmSync(report, { force: true });
      await launch(devControlCommand.parse(command), report);
      for (let waited = 0; waited < timeoutMs; waited += pollMs) {
        await new Promise((done) => setTimeout(done, pollMs));
        const output = existsSync(report) ? readFileSync(report, "utf8") : "";
        if (output.includes(EXIT_MARKER)) return output;
      }
      throw new Error(
        `scripts/dev.sh ${command} did not finish; see ${report}`,
      );
    },
  };
}
