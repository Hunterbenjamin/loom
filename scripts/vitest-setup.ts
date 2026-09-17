// Vitest global setup: sweep abandoned `loom-test-<pid>` tmux servers before and after a run.
// See packages/adapters/tmux/src/sweep.ts for why.
import { sweepTestServers } from "../packages/adapters/tmux/src/sweep.js";

async function sweep(when: string): Promise<void> {
  const swept = await sweepTestServers();
  if (swept.length)
    console.log(
      `${when}: swept ${swept.length} abandoned test tmux server${swept.length === 1 ? "" : "s"}`,
    );
}

export const setup = () => sweep("before tests");
export const teardown = () => sweep("after tests");
