import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    passWithNoTests: true,
    // Several agents run suites on one machine at once; end-to-end coordinator tests that pass in
    // isolation in seconds hit the 30 s default under that load.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
