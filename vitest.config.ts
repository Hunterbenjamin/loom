import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    passWithNoTests: true,
    // Each integration worker also spawns Git processes. CPU-count-sized pools oversubscribe
    // shared development machines before tests can make progress; bound the work at its source.
    maxWorkers: 2,
    // Interrupted runs leave `loom-test-<pid>` tmux servers behind; sweep them every run.
    globalSetup: ["./scripts/vitest-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
