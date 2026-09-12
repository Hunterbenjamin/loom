import { describe, expect, it } from "vitest";
import { fixture, now } from "../test/fixtures.js";
import type {
  ClaudeSessionObservation,
  CodexThreadObservation,
  PaneObservation,
  Run,
  RunObservation,
  WorktreePath,
} from "./index.js";
import { deriveStatus } from "./index.js";

const pane = (cwd: WorktreePath): PaneObservation => ({
  ref: {
    hostGeneration: "loom-dev#1",
    sessionName: "loom-t1",
    windowId: "@1",
    paneId: "%1",
  },
  cwd,
  startCwd: cwd,
  pid: 4242,
  command: "node",
  dead: false,
  exitCode: null,
});

function codex() {
  const f = fixture();
  const observation = f.observations.runs[1] as RunObservation;
  return {
    run: f.state.runs[1] as Run,
    observation,
    provider: (observation.provider.ok
      ? observation.provider.value
      : null) as CodexThreadObservation,
  };
}
function claude() {
  const f = fixture();
  const observation = f.observations.runs[2] as RunObservation;
  return {
    run: f.state.runs[2] as Run,
    observation,
    provider: (observation.provider.ok
      ? observation.provider.value
      : null) as ClaudeSessionObservation,
  };
}
describe("Codex status table", () => {
  const cases: [
    string,
    (p: CodexThreadObservation) => void,
    string,
    string | null,
  ][] = [
    [
      "active inProgress",
      (p) => {
        p.status = "active";
        p.turns = [
          {
            id: "turn",
            status: "inProgress",
            error: null,
            userMessageHashes: [],
          },
        ];
      },
      "working",
      null,
    ],
    [
      "approval",
      (p) => {
        p.status = "active";
        p.activeFlags = ["waitingOnApproval"];
      },
      "blocked",
      "permission",
    ],
    [
      "input",
      (p) => {
        p.status = "active";
        p.activeFlags = ["waitingOnUserInput"];
      },
      "blocked",
      "input",
    ],
    [
      "completed",
      (p) => {
        p.turns = [
          {
            id: "turn",
            status: "completed",
            error: null,
            userMessageHashes: [],
          },
        ];
      },
      "idle",
      null,
    ],
    [
      "interrupted",
      (p) => {
        p.turns = [
          {
            id: "turn",
            status: "interrupted",
            error: null,
            userMessageHashes: [],
          },
        ];
      },
      "idle",
      null,
    ],
    [
      "willRetry",
      (p) => {
        p.lastError = {
          kind: "serverOverloaded",
          willRetry: true,
          message: "Busy",
        };
      },
      "working",
      null,
    ],
    [
      "systemError",
      (p) => {
        p.status = "systemError";
      },
      "failed",
      null,
    ],
    [
      "failed turn",
      (p) => {
        p.turns = [
          {
            id: "turn",
            status: "failed",
            error: {
              kind: "other",
              willRetry: false,
              message: "Unsupported model",
            },
            userMessageHashes: [],
          },
        ];
      },
      "failed",
      null,
    ],
    [
      "rateLimitExceeded",
      (p) => {
        p.lastError = {
          kind: "rateLimitExceeded",
          willRetry: false,
          message: "Limit",
        };
      },
      "blocked",
      "rate_limit",
    ],
    [
      "usageLimitExceeded",
      (p) => {
        p.lastError = {
          kind: "usageLimitExceeded",
          willRetry: false,
          message: "Limit",
        };
      },
      "blocked",
      "rate_limit",
    ],
    [
      "usage denied",
      (p) => {
        p.rateLimits = { usageAllowed: false, resetsAt: null };
      },
      "blocked",
      "rate_limit",
    ],
    [
      "notLoaded",
      (p) => {
        p.status = "notLoaded";
      },
      "unknown",
      null,
    ],
  ];
  for (const [name, change, status, blockedOn] of cases)
    it(name, () => {
      const f = codex();
      change(f.provider);
      expect(deriveStatus(f.run, f.observation)).toMatchObject({
        status,
        blockedOn,
      });
    });
  it("unavailable provider beats a live pane", () => {
    const f = codex();
    f.observation.provider = { ok: false, reason: "Disconnected", at: now };
    f.observation.pane = { ok: true, at: now, value: pane(f.run.worktreePath) };
    expect(deriveStatus(f.run, f.observation)).toEqual({
      status: "unknown",
      blockedOn: null,
    });
  });
  it("closing pane leaves the live thread idle", () => {
    const f = codex();
    f.observation.pane = { ok: true, at: now, value: null };
    expect(deriveStatus(f.run, f.observation).status).toBe("idle");
  });
  it("a dead pane before any provider evidence is a failed launch", () => {
    const f = codex();
    f.run.seenAt = null;
    f.observation.provider = { ok: true, at: now, value: null };
    f.observation.pane = {
      ok: true,
      at: now,
      value: {
        ...pane(f.run.worktreePath),
        dead: true,
        exitCode: 1,
        cwd: null,
      },
    };
    expect(deriveStatus(f.run, f.observation)).toMatchObject({
      status: "ended",
      endReason: "vanished",
    });
  });
  it("gone and not resumable is vanished", () => {
    const f = codex();
    f.observation.provider = { ok: true, at: now, value: null };
    f.observation.resumable = false;
    expect(deriveStatus(f.run, f.observation)).toMatchObject({
      status: "ended",
      endReason: "vanished",
    });
  });
  it("an unreadable headless session the owner says is gone has crashed", () => {
    const f = codex();
    f.run.mode = "headless";
    f.observation.provider = { ok: false, reason: "not loaded", at: now };
    f.observation.resumable = false;
    expect(deriveStatus(f.run, f.observation)).toMatchObject({
      status: "failed",
      endReason: "crashed",
    });
  });
  it("an unreadable interactive session the owner says is gone vanished", () => {
    const f = codex();
    f.observation.provider = { ok: false, reason: "not loaded", at: now };
    f.observation.resumable = false;
    expect(deriveStatus(f.run, f.observation)).toMatchObject({
      status: "ended",
      endReason: "vanished",
    });
  });
  it("absence alone does not prove Codex vanished", () => {
    const f = codex();
    f.observation.provider = { ok: true, at: now, value: null };
    expect(deriveStatus(f.run, f.observation).status).toBe("unknown");
  });
});
describe("Claude status table", () => {
  const cases: [
    string,
    (r: Run, p: ClaudeSessionObservation, o: RunObservation) => void,
    string,
    string | null,
  ][] = [
    [
      "busy",
      (_, p) => {
        if (p.agentsEntry) p.agentsEntry.status = "busy";
        p.hooks.pendingDialog = { kind: "permission", tool: "Bash", at: now };
      },
      "working",
      null,
    ],
    [
      "waiting question",
      (_, p) => {
        if (p.agentsEntry) p.agentsEntry.status = "waiting";
        p.hooks.pendingDialog = {
          kind: "input",
          tool: "AskUserQuestion",
          at: now,
        };
      },
      "blocked",
      "input",
    ],
    [
      "waiting permission",
      (_, p) => {
        if (p.agentsEntry) p.agentsEntry.status = "waiting";
      },
      "blocked",
      "permission",
    ],
    ["idle", () => {}, "idle", null],
    [
      "SessionEnd",
      (_, p) => {
        p.agentsEntry = null;
        p.hooks.sessionEnd = { reason: "exit", at: now };
      },
      "ended",
      null,
    ],
    [
      "headless crash",
      (_, p) => {
        p.agentsEntry = null;
      },
      "failed",
      null,
    ],
    [
      "interactive disappearance",
      (r, p) => {
        r.mode = "interactive";
        p.agentsEntry = null;
      },
      "ended",
      null,
    ],
    [
      "never present",
      (r, p) => {
        r.seenAt = null;
        p.agentsEntry = null;
        p.hooks.sessionStart = null;
      },
      "starting",
      null,
    ],
    [
      // The pane host has no agent awareness: a folder-trust dialog looks exactly like a
      // slow start. It stays `starting` until the provider says otherwise (spike 06).
      "a live pane with no provider evidence stays starting",
      (r, p, o) => {
        r.mode = "interactive";
        r.seenAt = null;
        p.agentsEntry = null;
        p.hooks.sessionStart = null;
        o.pane = { ok: true, at: now, value: pane(r.worktreePath) };
      },
      "starting",
      null,
    ],
    [
      "StopFailure",
      (_, p) => {
        p.hooks.stopFailure = { error: "API error", at: now };
      },
      "failed",
      null,
    ],
    [
      "rate limit",
      (_, p) => {
        p.hooks.stopFailure = { error: "rate limit exceeded", at: now };
      },
      "blocked",
      "rate_limit",
    ],
    [
      "headless exit",
      (_, p) => {
        p.headless = { exited: true, exitCode: 1, error: "Crash" };
      },
      "failed",
      null,
    ],
    [
      "unavailable",
      (_, __, o) => {
        o.provider = { ok: false, reason: "Unavailable", at: now };
      },
      "unknown",
      null,
    ],
  ];
  for (const [name, change, status, blockedOn] of cases)
    it(name, () => {
      const f = claude();
      change(f.run, f.provider, f.observation);
      expect(deriveStatus(f.run, f.observation)).toMatchObject({
        status,
        blockedOn,
      });
    });
  it("a later event supersedes StopFailure", () => {
    const f = claude();
    f.provider.hooks.stopFailure = { error: "rate limit", at: now };
    f.provider.hooks.lastEventAt = "2026-09-12T00:01:00.000Z" as typeof now;
    expect(deriveStatus(f.run, f.observation).status).toBe("idle");
  });
  it("a reading for another session stays unknown", () => {
    const f = claude();
    f.run.sessionId = "different" as typeof f.run.sessionId;
    expect(deriveStatus(f.run, f.observation).status).toBe("unknown");
  });
});
