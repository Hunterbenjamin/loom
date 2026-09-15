import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    passWithNoTests: true,
    // Each integration worker also spawns Git processes. CPU-count-sized pools oversubscribe
    // shared development machines before tests can make progress; bound the work at its source.
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
