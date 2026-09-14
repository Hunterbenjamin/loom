import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { devControlCommand } from "../shared/ipc.js";

export function devControls(
  appPath: string,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv,
) {
  // In development app.getAppPath() is this checkout's apps/desktop directory.
  const root = resolve(appPath, "../..");
  const available = () =>
    !isPackaged && existsSync(join(root, "scripts/dev.sh"));
  return {
    available,
    run(raw: unknown): Promise<void> {
      const command = devControlCommand.parse(raw);
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
      args.push(`scripts/dev.sh ${command.replace("-", " ")}`);
      return new Promise((resolve, reject) => {
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
    },
  };
}
