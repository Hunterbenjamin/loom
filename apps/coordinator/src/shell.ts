// One repository command in one directory: WORKFLOW.md's `setup`, run by the coordinator after a
// worktree is created. Output is kept only to explain a failure; nothing is parsed from it.

import { execFile } from "node:child_process";

export type Shell = (command: string, cwd: string) => Promise<void>;

const SETUP_TIMEOUT_MS = 10 * 60_000;
const TAIL = 2_000;

export const runShell: Shell = (command, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve();
        const tail = `${stdout}\n${stderr}`.trim().slice(-TAIL);
        reject(
          new Error(
            `Workflow command failed in ${cwd}: ${error.message}${tail ? `\n${tail}` : ""}`,
          ),
        );
      },
    );
  });
