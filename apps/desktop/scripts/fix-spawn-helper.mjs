// npm and pnpm drop the exec bit on node-pty's prebuilt spawn-helper, which makes every
// pty.spawn fail with "posix_spawnp failed" (spike 03). Put it back after every install.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prebuilds = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "node-pty",
  "prebuilds",
);
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
