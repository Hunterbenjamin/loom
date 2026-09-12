import { describe, expect, it } from "vitest";
import { summarizeTask } from "./entities.js";

describe("summarizeTask", () => {
  it("returns the summary when present", () => {
    const task = {
      summary: "This is a one-line summary",
      description: "This is a longer description that should be ignored.",
    };
    expect(summarizeTask(task)).toBe("This is a one-line summary");
  });

  it("extracts first sentence when summary is null", () => {
    const task = {
      summary: null,
      description: "First sentence. Second sentence.",
    };
    expect(summarizeTask(task)).toBe("First sentence.");
  });

  it("handles description with question mark", () => {
    const task = {
      summary: null,
      description: "Is this working? Yes it is.",
    };
    expect(summarizeTask(task)).toBe("Is this working?");
  });

  it("handles description with exclamation mark", () => {
    const task = {
      summary: null,
      description: "This is great! Really great.",
    };
    expect(summarizeTask(task)).toBe("This is great!");
  });

  it("truncates very long first sentence", () => {
    const task = {
      summary: null,
      description:
        "This is a very long sentence that definitely exceeds the 140 character limit and should be truncated to fit within the maximum allowed length with more words to ensure we hit the limit.",
    };
    const result = summarizeTask(task);
    expect(result.length).toBeLessThanOrEqual(140);
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles description without punctuation", () => {
    const task = {
      summary: null,
      description: "This is the entire description without any punctuation",
    };
    expect(summarizeTask(task)).toBe(
      "This is the entire description without any punctuation",
    );
  });

  it("handles description with newline", () => {
    const task = {
      summary: null,
      description: "First line\nSecond line",
    };
    expect(summarizeTask(task)).toBe("First line");
  });

  it("returns empty string for empty description", () => {
    const task = {
      summary: null,
      description: "",
    };
    expect(summarizeTask(task)).toBe("");
  });

  it("returns empty string for whitespace-only description", () => {
    const task = {
      summary: null,
      description: "   \n  \t  ",
    };
    expect(summarizeTask(task)).toBe("");
  });

  it("handles summary with max length", () => {
    const longSummary = "a".repeat(140);
    const task = {
      summary: longSummary,
      description: "description",
    };
    expect(summarizeTask(task)).toBe(longSummary);
  });

  it("handles multiline description starting with sentence", () => {
    const task = {
      summary: null,
      description: "First sentence.\n\nParagraph with more details.",
    };
    expect(summarizeTask(task)).toBe("First sentence.");
  });
});
