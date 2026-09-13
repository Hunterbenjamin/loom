import { describe, expect, it } from "vitest";
import { settingsPatch, storedSettingsPatch } from "./settings.js";

describe("settings protocol compatibility", () => {
  it("preserves additive stored fields while rejecting them in write commands", () => {
    const stored = {
      futureSection: { enabled: true },
      workflow: { size: "small", futurePolicy: "careful" },
      roles: {
        planner: { futureCapability: "tools-v2" },
        futureRole: { provider: "codex" },
      },
    };
    expect(storedSettingsPatch.parse(stored)).toEqual(stored);
    expect(settingsPatch.safeParse(stored).success).toBe(false);
  });
});
