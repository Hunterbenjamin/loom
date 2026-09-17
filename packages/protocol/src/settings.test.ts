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

it("Main model is writable independently and retired Operator settings are rejected", () => {
  expect(settingsPatch.parse({ main: { model: "claude-opus-5" } })).toEqual({
    main: { model: "claude-opus-5" },
  });
  expect(
    settingsPatch.safeParse({ operator: { leadModel: "claude-opus-5" } })
      .success,
  ).toBe(false);
  expect(settingsPatch.safeParse({ operator: { policy: "v1" } }).success).toBe(
    false,
  );
});

it("research has its own strict profile outside pipeline roles", () => {
  expect(
    settingsPatch.parse({
      research: {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        depth: "deep",
      },
    }).research?.depth,
  ).toBe("deep");
  expect(settingsPatch.safeParse({ roles: { research: {} } }).success).toBe(
    false,
  );
  expect(
    settingsPatch.safeParse({ research: { depth: "unbounded" } }).success,
  ).toBe(false);
});

it("prefix wait accepts explicit null and retains the timed bounds", () => {
  for (const keyTimeoutMs of [null, 100, 3000, 60000])
    expect(
      settingsPatch.parse({ appearance: { keyTimeoutMs } }).appearance
        ?.keyTimeoutMs,
    ).toBe(keyTimeoutMs);
  for (const keyTimeoutMs of [0, 50, 90000])
    expect(
      settingsPatch.safeParse({ appearance: { keyTimeoutMs } }).success,
    ).toBe(false);
});
