import { describe, expect, it } from "vitest";
import { historyText, paneHostOf } from "./pane-history.js";

describe("paneHostOf", () => {
  it("reads the executable and socket from a tmux attach argv", () => {
    expect(
      paneHostOf(
        ["/opt/tmux", "-L", "loom-dev", "new-session", "-A", "-d"],
        "%7",
      ),
    ).toEqual({ tmux: "/opt/tmux", socket: "loom-dev", paneId: "%7" });
  });
  it("is null without a socket or a pane", () => {
    expect(paneHostOf(["tmux", "attach"], "%7")).toBeNull();
    expect(paneHostOf(["tmux", "-L", "loom-dev"], null)).toBeNull();
    expect(paneHostOf([], "%7")).toBeNull();
  });
});

describe("historyText", () => {
  it("turns capture-pane output into terminal input", () => {
    expect(historyText("one\n\x1b[31mtwo\x1b[0m\n")).toBe(
      "one\r\n\x1b[31mtwo\x1b[0m\x1b[m\r\n",
    );
  });
  it("is empty for a pane with no history", () => {
    expect(historyText("")).toBe("");
    expect(historyText("\n")).toBe("");
  });
  it("places every line at the pane's column", () => {
    expect(historyText("a\nb\n", 40)).toBe("\x1b[41Ga\r\n\x1b[41Gb\x1b[m\r\n");
  });
  it("keeps blank lines inside the history", () => {
    expect(historyText("a\n\nb\n\n\n")).toBe("a\r\n\r\nb\x1b[m\r\n");
  });
});
