import { describe, expect, it } from "vitest";
import { kittyEncode } from "./kitty.js";

const ESC = "\u001b";

describe("the kitty key encoder", () => {
  it("encodes Shift+Enter the way Herdr passes it through to the agent", () => {
    expect(
      kittyEncode({
        key: "Enter",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
      }),
    ).toBe(`${ESC}[13;2u`);
  });

  it("encodes Ctrl+Enter and Shift+Tab", () => {
    expect(
      kittyEncode({
        key: "Enter",
        shiftKey: false,
        altKey: false,
        ctrlKey: true,
      }),
    ).toBe(`${ESC}[13;5u`);
    expect(
      kittyEncode({
        key: "Tab",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
      }),
    ).toBe(`${ESC}[9;2u`);
  });

  it("leaves unmodified keys and unknown keys to xterm", () => {
    expect(
      kittyEncode({
        key: "Enter",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
      }),
    ).toBeNull();
    expect(
      kittyEncode({ key: "a", shiftKey: true, altKey: false, ctrlKey: false }),
    ).toBeNull();
  });
});
