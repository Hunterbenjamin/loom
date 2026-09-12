// The harness writes report.json and fails on the spot when a budget is missed. This re-checks
// the committed report in `pnpm test`, so a regression that was measured but not noticed still
// fails the suite.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const budgets = JSON.parse(
  readFileSync(join(here, "budgets.json"), "utf8"),
) as Record<string, { label: string; max?: number; min?: number }>;
const reportPath = join(here, "report.json");

interface Report {
  at: string;
  rows: { key: string; measured: number | null; ok: boolean }[];
  pass: boolean;
}

describe("the performance report", () => {
  it("exists; run `pnpm --filter @loom/desktop perf` to write it", () => {
    expect(existsSync(reportPath)).toBe(true);
  });

  const report: Report | null = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as Report)
    : null;

  it("covers every budget", () => {
    expect(report).not.toBeNull();
    const measured = new Set(report?.rows.map((row) => row.key));
    for (const key of Object.keys(budgets)) expect(measured).toContain(key);
  });

  for (const [key, budget] of Object.entries(budgets)) {
    it(`meets the budget: ${budget.label}`, () => {
      const row = report?.rows.find((candidate) => candidate.key === key);
      expect(row?.measured).toBeTypeOf("number");
      const value = row?.measured as number;
      if (budget.max !== undefined)
        expect(value).toBeLessThanOrEqual(budget.max);
      if (budget.min !== undefined)
        expect(value).toBeGreaterThanOrEqual(budget.min);
    });
  }
});
