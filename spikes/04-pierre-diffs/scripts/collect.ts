import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { manifestSchema } from "../src/schema.ts";

const root = join(tmpdir(), "loom-spike-04");
const evidence = new URL("../evidence/", import.meta.url);
mkdirSync(evidence, { recursive: true });
const metrics = z.object({
  firstDiffMs: z.number(),
  firstDiffNavigationMs: z.number(),
  firstHighlightMs: z.number().nullable(),
  parseMs: z.number(),
});
const schema = z
  .object({
    fixture: z.string(),
    workers: z.string(),
    repeat: z.number(),
    annotations: z.string().optional(),
    view: z.string().optional(),
    renderer: z.string().optional(),
    input: z.string().optional(),
    failed: z.string().optional(),
    peakRssMiB: z.number().optional(),
    before: z
      .object({ metrics, paints: z.array(z.object({ name: z.string(), ms: z.number() })) })
      .optional(),
    after: z
      .object({
        metrics,
        longTasks: z.array(z.number()),
        errors: z.array(z.string()),
        tokenSpans: z.number(),
      })
      .optional(),
    scroll: z
      .object({
        frameP95Ms: z.number(),
        maxFrameMs: z.number(),
        framesOver33Ms: z.number(),
        frameCount: z.number(),
      })
      .optional(),
    memory: z
      .object({
        peakRssMiB: z.number(),
        mainHeapBefore: z.object({ usedSize: z.number() }),
        mainHeapAfter: z.object({ usedSize: z.number() }),
      })
      .optional(),
    errors: z.array(z.string()),
  })
  .passthrough();
type Run = z.infer<typeof schema>;
const groups: Record<string, Run[]> = {};
for (const name of ["core", "annotations", "baselines", "inputs"]) {
  const raw = readFileSync(join(root, `bench-${name}.jsonl`), "utf8");
  groups[name] = raw
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)));
  writeFileSync(new URL(`bench-${name}.jsonl`, evidence), raw);
}
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const fmt = (value: number | null | undefined, precision = 0) =>
  value == null ? "—" : value.toFixed(precision);
const summaries: Record<string, unknown[]> = {};
const tables: string[] = [];
for (const [name, runs] of Object.entries(groups)) {
  const byCase = new Map<string, Run[]>();
  for (const run of runs) {
    const key = JSON.stringify([
      run.fixture,
      run.workers,
      run.annotations ?? "0",
      run.view ?? "split",
      run.renderer ?? "codeview",
      run.input ?? "patch",
    ]);
    byCase.set(key, [...(byCase.get(key) ?? []), run]);
  }
  tables.push(
    `**${name === "core" ? "Required sizes (three runs per setting)" : name === "annotations" ? "Annotations and unified layout (three runs per setting)" : name === "baselines" ? "Renderer baselines (one exploratory run per setting)" : "Input paths (one exploratory run per setting)"}.**`,
  );
  tables.push(
    "\n| Case | Workers | n | Parse ms | FCP ms | Diff paint proxy ms | Highlight ms | Scroll p95 ms | Worst long task ms | Peak browser RSS MiB |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  summaries[name] = [];
  for (const set of byCase.values()) {
    const first = set[0];
    const label = [
      first.fixture,
      first.annotations && `${first.annotations} cards`,
      first.view,
      first.renderer,
      first.input,
    ]
      .filter(Boolean)
      .join(" / ");
    const ok = set.filter((r) => !r.failed && r.before && r.after && r.scroll && r.memory);
    const values = {
      label,
      workers: first.workers,
      n: set.length,
      passed: ok.length,
      parseMs: median(ok.map((r) => r.after!.metrics.parseMs)),
      fcpMs: median(
        ok.flatMap((r) =>
          r.before!.paints.filter((p) => p.name === "first-contentful-paint").map((p) => p.ms),
        ),
      ),
      paintMs: median(ok.map((r) => r.after!.metrics.firstDiffMs)),
      navigationDiffMs: median(ok.map((r) => r.after!.metrics.firstDiffNavigationMs)),
      highlightMs: median(
        ok.flatMap((r) =>
          r.after!.metrics.firstHighlightMs == null ? [] : [r.after!.metrics.firstHighlightMs],
        ),
      ),
      scrollP95Ms: median(ok.map((r) => r.scroll!.frameP95Ms)),
      worstLongTaskMs: ok.length ? Math.max(0, ...ok.flatMap((r) => r.after!.longTasks)) : null,
      worstFrameMs: ok.length ? Math.max(...ok.map((r) => r.scroll!.maxFrameMs)) : null,
      peakRssLow: Math.min(...set.map((r) => r.memory?.peakRssMiB ?? r.peakRssMiB ?? 0)),
      peakRssHigh: Math.max(...set.map((r) => r.memory?.peakRssMiB ?? r.peakRssMiB ?? 0)),
      mainHeapMiB: median(
        ok.map(
          (r) =>
            Math.max(r.memory!.mainHeapBefore.usedSize, r.memory!.mainHeapAfter.usedSize) /
            1024 ** 2,
        ),
      ),
      failures: set.filter((r) => r.failed).map((r) => r.failed),
      errors: set.flatMap((r) => [...r.errors, ...(r.after?.errors ?? [])]),
    };
    summaries[name].push(values);
    tables.push(
      `| ${label}${values.failures.length ? ` (${values.failures.join("; ")})` : ""} | ${first.workers === "1" ? "4" : "0"} | ${ok.length}/${set.length} | ${fmt(values.parseMs, 1)} | ${fmt(values.fcpMs)} | ${fmt(values.paintMs)} | ${fmt(values.highlightMs)} | ${fmt(values.scrollP95Ms, 1)} | ${fmt(values.worstLongTaskMs)} | ${fmt(values.peakRssLow)}–${fmt(values.peakRssHigh)} |`,
    );
  }
  tables.push("");
}
writeFileSync(new URL("summary.json", evidence), JSON.stringify(summaries, null, 2));
writeFileSync(join(root, "performance-tables.md"), tables.join("\n"));
writeFileSync(
  new URL("fixtures.json", evidence),
  JSON.stringify(
    manifestSchema.parse(JSON.parse(readFileSync(join(root, "data/manifest.json"), "utf8"))),
    null,
    2,
  ),
);
for (const file of [
  "features.json",
  "inputs.json",
  "comparison.json",
  "review-dark.png",
  "review-light-unified.png",
  "edge-inputs.png",
])
  copyFileSync(join(root, file), new URL(file, evidence));
const commit = z.object({
  number: z.number(),
  baseRefOid: z.string().regex(/^[a-f0-9]{40}$/),
  headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
  mergeCommit: z.object({ oid: z.string().regex(/^[a-f0-9]{40}$/) }),
});
writeFileSync(
  new URL("github-source.json", evidence),
  JSON.stringify(
    commit.parse(JSON.parse(readFileSync(join(root, "github-15477.json"), "utf8"))),
    null,
    2,
  ),
);
console.log(tables.join("\n"));
