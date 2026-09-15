import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "codex-cli 0.154.0";
if (
  execFileSync("codex", ["--version"], { encoding: "utf8" }).trim() !== version
) {
  throw new Error(`Bindings require ${version}`);
}
const temp = mkdtempSync(join(tmpdir(), "loom-codex-bindings-"));
const output = fileURLToPath(new URL("../src/generated/", import.meta.url));
const roots = [
  "InitializeParams",
  "InitializeResponse",
  "v2/ThreadStartParams",
  "v2/ThreadResumeParams",
  "v2/ThreadReadParams",
  "v2/TurnStartParams",
  "v2/TurnSteerParams",
  "v2/TurnInterruptParams",
  "v2/ThreadUnsubscribeParams",
  "v2/ThreadTokenUsageUpdatedNotification",
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalResponse",
  "v2/ToolRequestUserInputResponse",
  "v2/PermissionsRequestApprovalResponse",
];
const copied = new Set();
function copy(relative) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const source = readFileSync(join(temp, `${relative}.ts`), "utf8");
  for (const match of source.matchAll(/from "([^"]+)"/g)) {
    const dependency = resolve(dirname(join(temp, relative)), match[1]);
    copy(dependency.slice(temp.length + 1));
  }
  const target = join(output, `${relative}.ts`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source.replace(/from "([^"]+)"/g, 'from "$1.js"'));
}
try {
  execFileSync("codex", [
    "app-server",
    "generate-ts",
    "--experimental",
    "--out",
    temp,
  ]);
  for (const root of roots) copy(root);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
