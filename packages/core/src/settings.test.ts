import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  resolveSettings,
  SETTINGS_CATALOG,
  type SettingsValues,
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

  it("adds new default bindings without replacing saved shortcuts or unbound actions", () => {
    const keybindings = structuredClone(DEFAULT_SETTINGS.appearance.keybindings);
    delete keybindings["terminal-focus"];
    keybindings.new = ["Cmd+U"];
    keybindings.close = [];
    const resolved = resolveSettings({ appearance: { keybindings } }, null, null);
    expect(resolved.effective.appearance.keybindings["terminal-focus"]).toEqual(
      ["Prefix q"],
    );
    expect(resolved.effective.appearance.keybindings.new).toEqual(["Cmd+U"]);
    expect(resolved.effective.appearance.keybindings.close).toEqual([]);
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

  it("applies provider model environment values after repository routing", () => {
    const resolved = resolveSettings(
      null,
      {
        roles: {
          planner: { provider: "claude", model: "claude-opus-4-6" },
          implementer: { provider: "codex", model: "gpt-5.4" },
        },
      },
      null,
      DEFAULT_SETTINGS,
      {
        models: { codex: "gpt-5.6-sol" },
        codexReasoningEffort: "high",
      },
    );
    expect(resolved.effective.roles.planner).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-6",
    });
    expect(resolved.sources["roles.planner.model"]).toBe("repository");
    expect(resolved.effective.roles.implementer).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(resolved.sources["roles.implementer.model"]).toBe("environment");
    expect(resolved.sources["roles.implementer.reasoningEffort"]).toBe(
      "environment",
    );
  });
});

describe("settings validation", () => {
  const copy = () =>
    JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
  it("accepts the default settings", () => {
    expect(validateSettings(copy())).toEqual([]);
  });

  it.each<[string, (settings: SettingsValues) => void]>([
    [
      "unknown model",
      (s) => {
        s.roles.planner.model = "made-up";
      },
    ],
    [
      "Claude reasoning effort",
      (s) => {
        s.roles.implementer.reasoningEffort = "high";
      },
    ],
    [
      "headless approval-gated access",
      (s) => {
        s.roles.reviewer.access = "approval-gated";
        s.roles.reviewer.runMode = "headless";
      },
    ],
    [
      "retry base above cap",
      (s) => {
        s.runtime.retryBaseMs = 20;
        s.runtime.retryCapMs = 10;
      },
    ],
    [
      "zero review rounds",
      (s) => {
        s.workflow.reviewRoundCap = 0;
      },
    ],
    [
      "invalid key prefix",
      (s) => {
        s.appearance.keyPrefix = "not+a+chord";
      },
    ],
    [
      "missing keybinding",
      (s) => {
        delete s.appearance.keybindings.help;
      },
    ],
    [
      "invalid keybinding",
      (s) => {
        s.appearance.keybindings.close = ["Prefix not+a+chord"];
      },
    ],
  ])("rejects %s with a diagnostic", (_name, invalidate) => {
    const settings = copy();
    invalidate(settings);
    const errors = validateSettings(settings);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.trim().length > 0)).toBe(true);
  });
});

it("the catalog and effective settings expose only Main, ignoring retired fields", () => {
  const legacy = {
    operator: { policy: "v1" },
    main: { model: "claude-opus-5" },
  };
  const effective = resolveSettings(legacy, null, {
    main: { model: "claude-opus-4-6" },
  }).effective;
  expect(effective.main.model).toBe("claude-opus-4-6");
  expect(effective).not.toHaveProperty("operator");
  expect(
    SETTINGS_CATALOG.some((setting) => setting.key.startsWith("operator.")),
  ).toBe(false);
  expect(
    SETTINGS_CATALOG.filter((setting) => setting.section === "Main").map(
      (setting) => setting.key,
    ),
  ).toEqual(["main.model"]);
});

it("Research defaults to Codex and validates its independent model and reasoning profile", () => {
  expect(DEFAULT_SETTINGS.research.provider).toBe("codex");
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    research: { depth: "deep", reasoningEffort: "high" },
  });
  expect(settings.research).toMatchObject({
    depth: "deep",
    reasoningEffort: "high",
  });
  expect(settings.roles).toEqual(DEFAULT_SETTINGS.roles);
  expect(validateSettings(settings)).toEqual([]);
  expect(
    validateSettings(
      mergeSettings(settings, { research: { provider: "claude" } }),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Unknown claude model for research"),
      expect.stringContaining("Claude does not accept"),
    ]),
  );
});
