// Playwright driver for the spike 03 Electron app.
// Usage: node drive.mjs <xterm|ghostty> <scenario> [args...]
// Scenarios live in scenarios.mjs. Output: JSON on stdout, screenshots in $S03_OUT/shots.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import * as basic from './scenarios.mjs';
import * as perf from './scenarios-perf.mjs';

const scenarios = { ...basic, ...perf };

const here = path.dirname(fileURLToPath(import.meta.url));
const [renderer = 'xterm', name = 'smoke', ...rest] = process.argv.slice(2);
const out = process.env.S03_OUT ?? path.join(process.env.TMPDIR ?? '/tmp', 'loom-spike-03-embedded-terminal');
const shots = path.join(out, 'shots');
mkdirSync(shots, { recursive: true });

const scenario = scenarios[name];
if (!scenario) {
  console.error(`unknown scenario ${name}; have: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

export async function launch(extraEnv = {}) {
  const app = await electron.launch({
    args: [here],
    cwd: here,
    env: { ...process.env, S03_RENDERER: renderer, ...extraEnv },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.s03 !== undefined);
  page.on('console', (m) => {
    if (process.env.S03_DEBUG || m.type() === 'error' || m.type() === 'warning')
      console.error(`[renderer ${m.type()}]`, m.text());
  });
  return { app, page };
}

const ctx = {
  renderer,
  args: rest,
  out,
  launch,
  shot: (page, label) =>
    page.screenshot({ path: path.join(shots, `${renderer}${process.env.S03_TAG ?? ''}-${label}.png`) }),
  sleep: (t) => new Promise((r) => setTimeout(r, t)),
};

try {
  const result = await scenario(ctx);
  console.log(JSON.stringify({ renderer, scenario: name, result }, null, 1));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
