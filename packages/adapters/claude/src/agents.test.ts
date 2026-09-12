import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseAgentsOutput } from "./agents.js";

const fixture = readFileSync(
  new URL("./fixtures/agents.json", import.meta.url),
  "utf8",
);

describe("claude agents --json", () => {
  test("parses recorded output", () => {
    expect(parseAgentsOutput(fixture)).toEqual([
      {
        sessionId: "17f1f804-b30f-444a-a4ec-f6d6ba8c7842",
        status: "busy",
        rawStatus: "busy",
        kind: "interactive",
        pid: 80216,
        cwd: "/Users/example/.herdr/worktrees/loom/feat-ui-shell",
      },
      {
        sessionId: "03f930c5-6f2b-492c-a82a-5d6a68cd35aa",
        status: "waiting",
        rawStatus: "waiting",
        kind: "interactive",
        pid: 87154,
        cwd: "/Users/example/.herdr/worktrees/loom/feat-adapter-claude",
      },
      {
        sessionId: "3ceeb489-6eda-4a19-9a8f-2f1c7f4c18b1",
        status: "idle",
        rawStatus: "idle",
        kind: "background",
        pid: 86722,
        cwd: "/private/var/folders/q4/40hztcsn5pl4nj5rx75sgzlr0000gn/T/loom-spike-02/bgrepo",
      },
    ]);
  });

  test("an unseen status falls back to other, keeping the raw value", () => {
    const [entry] = parseAgentsOutput(
      JSON.stringify([
        {
          sessionId: "s",
          cwd: "/w",
          kind: "compacting",
          status: "compacting",
        },
      ]),
    );
    expect(entry).toEqual({
      sessionId: "s",
      status: "other",
      rawStatus: "compacting",
      kind: "other",
      pid: null,
      cwd: "/w",
    });
  });

  test("an empty list is a valid answer: no sessions, not an error", () => {
    expect(parseAgentsOutput("[]")).toEqual([]);
  });

  test("output that isn't the documented shape is rejected, never guessed at", () => {
    expect(() => parseAgentsOutput('[{"sessionId":"s"}]')).toThrow();
    expect(() => parseAgentsOutput('{"agents":[]}')).toThrow();
    expect(() => parseAgentsOutput("not json")).toThrow();
  });
});
