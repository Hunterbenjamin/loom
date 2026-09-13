import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  resolveSettings,
  validateSettings,
} from "./settings.js";

describe("settings resolution", () => {
  it("uses environment over repository over global over defaults and reports each source", () => {
    const resolved = resolveSettings(
      { workflow: { size: "small", reviewRoundCap: 5 } },
      { workflow: { size: "normal" }, appearance: { theme: "light" } },
      { workflow: { reviewRoundCap: 7 } },
    );
    expect(resolved.effective.workflow).toMatchObject({
      size: "normal",
      reviewRoundCap: 7,
    });
    expect(resolved.effective.appearance.theme).toBe("light");
    expect(resolved.sources["workflow.size"]).toBe("repository");
    expect(resolved.sources["workflow.reviewRoundCap"]).toBe("environment");
    expect(resolved.sources["appearance.theme"]).toBe("repository");
    expect(resolved.sources["appearance.chime"]).toBe("default");
  });

  it("merges role profile fields without drifting other roles", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      roles: { planner: { runMode: "headless" } },
    });
    expect(merged.roles.planner.runMode).toBe("headless");
    expect(merged.roles.planner.model).toBe(
      DEFAULT_SETTINGS.roles.planner.model,
    );
    expect(merged.roles.reviewer).toEqual(DEFAULT_SETTINGS.roles.reviewer);
  });
});

describe("settings validation", () => {
  const copy = () =>
    JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
  it("rejects unknown models, provider reasoning mismatches and unanswerable access", () => {
    const invalid = copy();
    invalid.roles.planner.model = "made-up";
    invalid.roles.implementer.reasoningEffort = "high";
    invalid.roles.reviewer.access = "approval-gated";
    invalid.roles.reviewer.runMode = "headless";
    expect(validateSettings(invalid)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unknown codex model for planner"),
        expect.stringContaining("Claude does not accept"),
        expect.stringContaining("approval-gated access requires interactive"),
      ]),
    );
  });

  it("rejects invalid retry and numeric relationships", () => {
    const invalid = copy();
    invalid.runtime.retryBaseMs = 20;
    invalid.runtime.retryCapMs = 10;
    invalid.workflow.reviewRoundCap = 0;
    expect(validateSettings(invalid)).toEqual(
      expect.arrayContaining([
        "Retry base must not exceed retry cap",
        "Review round cap must be positive",
      ]),
    );
  });
});
