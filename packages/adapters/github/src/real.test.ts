import { expect, it } from "vitest";
import { runGh } from "./gh.js";
import { createGitHubAdapter } from "./index.js";

it.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "reads a public PR and polls conditionally without writes",
  async () => {
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async (args, input) => {
        if (
          args[0] !== "api" ||
          !args.includes("GET") ||
          !args.some((arg) => arg.startsWith("repos/vuejs/core/"))
        )
          throw new Error("Real test permits only GET requests to vuejs/core");
        return runGh(args, input);
      },
    });
    const req = {
      repo: "vuejs/core",
      branch: "edison/perf/treeshaking",
      etag: null,
    };
    const first = await adapter.findPullRequest(req);
    expect(first.notModified).toBe(false);
    if (first.notModified || !first.value)
      throw new Error("Public fixture PR not found");
    expect(first.value.number).toBe(15477);
    expect(first.value.ci.checks.length).toBeGreaterThan(0);
    expect(first.value.ci.checks.every((check) => /^\d+$/.test(check.id))).toBe(
      true,
    );
    const second = await adapter.findPullRequest({ ...req, etag: first.etag });
    if (!second.notModified) expect(second.value?.number).toBe(15477); // Live owner may change.
  },
  120_000,
);
