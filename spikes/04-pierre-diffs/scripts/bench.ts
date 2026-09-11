import { chromium, type CDPSession } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, arch, release, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const root = join(tmpdir(), "loom-spike-04");
mkdirSync(root, { recursive: true });
// Keep Playwright's automatically generated profiles/downloads inside spike scratch.
// This environment override affects only this runner and the children it launches.
process.env.TMPDIR = root;
const group = z
  .enum(["core", "annotations", "baselines", "inputs", "smoke"])
  .parse(process.argv[2] ?? "core");
const repeats = z.coerce
  .number()
  .int()
  .min(1)
  .max(5)
  .parse(
    process.argv[3] ?? (group === "baselines" || group === "inputs" || group === "smoke" ? 1 : 3),
  );
type Case = {
  fixture: string;
  workers: string;
  annotations?: string;
  view?: string;
  renderer?: string;
  input?: string;
};
const cases: Case[] = [];
const add = (fixture: string, extra: Partial<Case> = {}) => {
  for (const workers of ["0", "1"]) cases.push({ fixture, workers, ...extra });
};
if (group === "core") for (const fixture of ["medium", "large", "single", "lockfile"]) add(fixture);
if (group === "annotations") {
  add("medium", { annotations: "50" });
  add("medium", { annotations: "200" });
  add("large", { annotations: "200" });
  add("large", { view: "unified" });
}
if (group === "baselines") {
  add("large", { renderer: "plain" });
  add("single", { renderer: "plain" });
  add("large", { renderer: "virtualizer" });
}
if (group === "inputs") {
  add("medium", { input: "contents" });
  add("single", { input: "contents" });
  add("github");
  add("commits");
  add("edges");
}
if (group === "smoke") add("medium", { annotations: "50" });
const output = join(root, `bench-${group}.jsonl`);
writeFileSync(output, "");
const processSchema = z.object({
  processInfo: z.array(z.object({ id: z.number().int(), type: z.string(), cpuTime: z.number() })),
});
async function rss(cdp: CDPSession) {
  const { processInfo } = processSchema.parse(await cdp.send("SystemInfo.getProcessInfo"));
  // These PIDs come only from the separate browser we launched, never other apps.
  const raw = execFileSync("ps", ["-o", "rss=", "-p", processInfo.map((p) => p.id).join(",")], {
    encoding: "utf8",
  });
  const kib = z.array(z.coerce.number().nonnegative()).parse(raw.trim().split(/\s+/));
  return kib.reduce((sum, value) => sum + value, 0) / 1024;
}
const machine = {
  node: process.version,
  platform: platform(),
  arch: arch(),
  osRelease: release(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  ramGiB: totalmem() / 1024 ** 3,
  viewport: "1440x1000",
  headless: true,
};
for (const scenario of cases)
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const label = { ...scenario, repeat };
    console.log("START", JSON.stringify(label));
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const browserCdp = await browser.newBrowserCDPSession();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageCdp = await page.context().newCDPSession(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(30000);
    let sampling = false;
    let memoryLimitReached = false;
    const rssLimitMiB = 1800;
    const memory: { at: number; rssMiB: number }[] = [];
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const rssMiB = await rss(browserCdp);
        memory.push({ at: Date.now(), rssMiB });
        if (rssMiB > rssLimitMiB && !memoryLimitReached) {
          memoryLimitReached = true;
          // Bound throwaway browser memory on the user's 8 GiB machine.
          void browser.close();
        }
      } catch {
        /* process can exit between enumeration and ps */
      } finally {
        sampling = false;
      }
    };
    await sample();
    const baselineRssMiB = memory[0]?.rssMiB;
    const interval = setInterval(() => {
      void sample();
    }, 500);
    try {
      await page.goto(`http://127.0.0.1:4404/?${new URLSearchParams(scenario)}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForFunction(() => window.spike?.metrics.firstDiffMs != null, undefined, {
        timeout: 45000,
      });
      await page.waitForTimeout(1500);
      const before = await page.evaluate(() => ({
        measuredAtMs: performance.now(),
        metrics: window.spike.metrics,
        paints: performance
          .getEntriesByType("paint")
          .map((e) => ({ name: e.name, ms: e.startTime })),
        longTasks: [...window.spike.longTasks],
      }));
      const heapBefore = await pageCdp.send("Runtime.getHeapUsage");
      const domBefore = await pageCdp.send("Memory.getDOMCounters");
      const rssBefore = await rss(browserCdp);
      const scroll = await page.evaluate(async () => {
        const root = document.querySelector<HTMLElement>(".diff-scroll")!;
        const gaps: number[] = [];
        let last = performance.now();
        const start = last;
        let frames = 0;
        let direction = 1;
        const startLongTasks = window.spike.longTasks.length;
        await new Promise<void>((resolve) => {
          const tick = (now: number) => {
            gaps.push(now - last);
            last = now;
            frames++;
            root.scrollTop += 180 * direction;
            if (root.scrollTop >= root.scrollHeight - root.clientHeight - 2) direction = -1;
            if (root.scrollTop <= 0) direction = 1;
            if (now - start < 6000) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        const sorted = gaps.slice(1).sort((a, b) => a - b);
        return {
          durationMs: last - start,
          frames,
          frameP50Ms: sorted[Math.floor(sorted.length * 0.5)],
          frameP95Ms: sorted[Math.floor(sorted.length * 0.95)],
          maxFrameMs: Math.max(...sorted),
          framesOver33Ms: sorted.filter((x) => x > 33.4).length,
          frameCount: sorted.length,
          scrollHeight: root.scrollHeight,
          scrollTop: root.scrollTop,
          scrollLongTasks: window.spike.longTasks.slice(startLongTasks),
        };
      });
      // Exercise far-away items separately; continuous scrolling numbers above exclude jumps.
      await page.evaluate(() =>
        window.spike.scrollTo?.(Number(window.spike.metrics.fileCount) - 1),
      );
      await page.waitForTimeout(1000);
      // Do not terminate the expensive worker case before highlighting finishes.
      // This wait is outside the scroll measurement; retain both timings explicitly.
      if (scenario.workers === "1")
        await page.waitForFunction(
          () => {
            const stats = window.spike.metrics.workerStats as {
              managerState: string;
              activeTasks: number;
              queuedTasks: number;
            } | null;
            return (
              stats?.managerState === "initialized" &&
              stats.activeTasks === 0 &&
              stats.queuedTasks === 0
            );
          },
          undefined,
          { timeout: 45000 },
        );
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({
        measuredAtMs: performance.now(),
        metrics: window.spike.metrics,
        errors: window.spike.errors,
        longTasks: window.spike.longTasks,
        mountedDiffs: document.querySelectorAll("diffs-container").length,
        mountedCards: document.querySelectorAll("[data-finding]").length,
        tokenSpans: Array.from(document.querySelectorAll("diffs-container")).reduce(
          (n, h) =>
            n +
            (h.shadowRoot?.querySelectorAll('[data-code] [style*="--diffs-token-"]').length ?? 0),
          0,
        ),
      }));
      const heapAfter = await pageCdp.send("Runtime.getHeapUsage");
      const domAfter = await pageCdp.send("Memory.getDOMCounters");
      await sample();
      const result = {
        ...label,
        machine: { ...machine, chrome: browser.version() },
        before,
        scroll,
        after,
        memory: {
          baselineRssMiB,
          settledRssMiB: rssBefore,
          peakRssMiB: Math.max(...memory.map((m) => m.rssMiB)),
          samples: memory.length,
          mainHeapBefore: heapBefore,
          mainHeapAfter: heapAfter,
          domBefore,
          domAfter,
        },
        errors,
      };
      appendFileSync(output, JSON.stringify(result) + "\n");
      console.log(
        "DONE",
        JSON.stringify({
          ...label,
          firstDiffMs: before.metrics.firstDiffMs,
          frameP95: scroll.frameP95Ms,
          peakRssMiB: result.memory.peakRssMiB,
          errors,
        }),
      );
    } catch (error) {
      const result = {
        ...label,
        failed: memoryLimitReached
          ? `Stopped at ${rssLimitMiB} MiB browser RSS guard`
          : String(error).split("\n")[0],
        errors,
        peakRssMiB: Math.max(...memory.map((m) => m.rssMiB)),
      };
      appendFileSync(output, JSON.stringify(result) + "\n");
      console.log("FAILED", JSON.stringify(result));
    } finally {
      clearInterval(interval);
      await browser.close();
    }
  }
console.log("OUTPUT", output);
