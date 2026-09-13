import { expect, test } from "vitest";
import {
  applyStoredSettingsToConfig,
  configFromEnvironment,
  settingsDefaultsForConfig,
} from "./config.js";

test("Main settings keep their environment override while Operator environment is ignored", () => {
  const config = configFromEnvironment({
    LOOM_INSTANCE: "test",
    LOOM_DATA_ROOT: "/tmp/loom-settings-test",
    LOOM_TOKEN: "test-token-0123456789abcdef",
    LOOM_MODEL_LEAD: "claude-opus-5",
    LOOM_MODEL_OPERATOR: "retired-model",
    LOOM_OPERATOR_REPO: "retired-repo",
    LOOM_OPERATOR_MAX_FILED_PER_HOUR: "invalid-retired-setting",
    LOOM_OPERATOR_AUTO_FIX: "retired-policy",
  });
  expect(config).not.toHaveProperty("operator");
  expect(config).not.toHaveProperty("operatorModel");
  expect(config.settingsEnvironment).not.toHaveProperty("operator");
  expect(config.settingsEnvironment?.main).toEqual({ model: "claude-opus-5" });
  const settings = settingsDefaultsForConfig(config);
  expect(settings.main.model).toBe("claude-opus-5");
  settings.main.model = "claude-opus-4-6";
  applyStoredSettingsToConfig(config, settings, false);
  expect(config.leadModel).toBe("claude-opus-4-6");
});
