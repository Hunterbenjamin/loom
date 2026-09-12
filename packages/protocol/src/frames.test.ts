import { describe, expect, it } from "vitest";
import { ack, command, protocolError } from "./commands.js";
import {
  CLOSE,
  clientFrame,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  serverFrame,
  supportsVersion,
} from "./frames.js";
import { at, id, meta, snapshot, stream } from "./test-support.js";

const hello = {
  type: "hello" as const,
  protocolVersion: PROTOCOL_VERSION,
  token: "loom-token",
  client: {
    id: "window-1",
    kind: "tracker" as const,
    name: "Loom",
    version: "0.0.0",
  },
  subscriptions: [
    { kind: "views" as const, views: ["needs_you" as const], repoIds: null },
  ],
};

const welcome = {
  type: "welcome" as const,
  protocolVersion: PROTOCOL_VERSION,
  coordinator: {
    instance: "dev",
    version: "0.0.0",
    startedAt: at("2026-09-12T08:00:00.000Z"),
  },
  clientId: "window-1",
  heartbeatMs: 15_000,
  limits: { maxFrameBytes: MAX_FRAME_BYTES, maxSubscriptions: 256 },
};

describe("the handshake", () => {
  it("round-trips hello and welcome", () => {
    expect(decodeClientFrame(encodeFrame(hello))).toEqual({
      ok: true,
      frame: hello,
    });
    expect(decodeServerFrame(encodeFrame(welcome))).toEqual({
      ok: true,
      frame: welcome,
    });
  });

  it("accepts only this protocol version", () => {
    expect(supportsVersion(PROTOCOL_VERSION)).toBe(true);
    expect(supportsVersion(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it("refuses a hello with no token, so an unauthenticated socket cannot proceed", () => {
    const decoded = decodeClientFrame(encodeFrame({ ...hello, token: "" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.code).toBe("invalid_frame");
  });

  it("keeps a close code for every way the handshake can end", () => {
    expect(new Set(Object.values(CLOSE)).size).toBe(Object.keys(CLOSE).length);
    expect(Object.values(CLOSE).every((c) => c >= 4000 && c <= 4999)).toBe(
      true,
    );
  });
});

describe("framing", () => {
  it("round-trips a snapshot frame and a patch frame", () => {
    const body = snapshot();
    const frame = {
      type: "snapshot" as const,
      ...meta,
      requestId: null,
      scope: [{ kind: "task" as const, taskId: id.task("LOOM-101") }],
      body,
    };
    expect(decodeServerFrame(encodeFrame(frame))).toEqual({
      ok: true,
      frame,
    });
    for (const patch of stream(body)) {
      const wire = { type: "patch" as const, ...patch };
      expect(decodeServerFrame(encodeFrame(wire))).toEqual({
        ok: true,
        frame: wire,
      });
    }
  });

  it("reports bad JSON and a schema failure as protocol errors, not throws", () => {
    const broken = decodeClientFrame("{not json");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.code).toBe("invalid_frame");

    const unknown = decodeClientFrame(JSON.stringify({ type: "nope" }));
    expect(unknown.ok).toBe(false);

    const wrong = decodeServerFrame(
      JSON.stringify({ type: "patch", seq: 0, now: meta.now, changes: [] }),
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.details.length).toBeGreaterThan(0);
  });

  it("rejects a frame over the size limit before parsing it", () => {
    const huge = JSON.stringify({
      type: "ping",
      pad: "x".repeat(MAX_FRAME_BYTES),
    });
    const decoded = decodeClientFrame(huge);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok)
      expect(decoded.error.details[0]).toContain(String(MAX_FRAME_BYTES));
  });

  it("rejects a server frame on the client channel and the other way round", () => {
    expect(decodeClientFrame(encodeFrame(welcome)).ok).toBe(false);
    expect(decodeServerFrame(encodeFrame(hello)).ok).toBe(false);
  });

  it("round-trips a heartbeat", () => {
    const ping = { type: "ping" as const, at: meta.now };
    expect(clientFrame.parse(ping)).toEqual(ping);
    expect(serverFrame.parse(ping)).toEqual(ping);
  });
});

describe("commands", () => {
  const cases = [
    {
      kind: "human" as const,
      taskId: id.task("LOOM-101"),
      command: { type: "approve" as const, headSha: "2".repeat(40) },
    },
    {
      kind: "human" as const,
      taskId: id.task("LOOM-101"),
      command: {
        type: "answer_provider_request" as const,
        runId: id.run("LOOM-101/implementer/0"),
        requestId: "req_88",
        generation: null,
        decision: "accept" as const,
        answers: null,
      },
    },
    {
      kind: "open_attach_session" as const,
      runId: id.run("LOOM-101/implementer/0"),
    },
    {
      kind: "fetch_diff" as const,
      taskId: id.task("LOOM-101"),
      range: { mode: "whole_branch" as const },
    },
    {
      kind: "fetch_diff" as const,
      taskId: id.task("LOOM-101"),
      range: { baseSha: "1".repeat(40), headSha: "2".repeat(40) },
    },
    {
      kind: "save_review_state" as const,
      taskId: id.task("LOOM-101"),
      change: {
        headSha: "2".repeat(40),
        currentFile: "f-views",
        unviewed: ["f-patch"],
      },
    },
  ];

  for (const value of cases)
    it(`round-trips ${value.kind}`, () => {
      expect(command.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    });

  it("acknowledges a human command with the input ID it was recorded as", () => {
    const ok = {
      type: "ack" as const,
      requestId: "r1",
      outcome: {
        ok: true as const,
        result: { kind: "human" as const, inputId: id.input("in-12") },
      },
    };
    expect(ack.parse(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  });

  it("acknowledges a rejected command with a typed error", () => {
    const failed = {
      type: "ack" as const,
      requestId: "r2",
      outcome: {
        ok: false as const,
        error: {
          code: "wrong_stage" as const,
          message: "approve is not allowed in in_progress",
          details: ["stage=in_progress"],
        },
      },
    };
    expect(ack.parse(JSON.parse(JSON.stringify(failed)))).toEqual(failed);
    expect(
      protocolError.safeParse({ code: "made_up", message: "x", details: [] })
        .success,
    ).toBe(false);
  });

  it("refuses a command that names no task", () => {
    expect(
      command.safeParse({ kind: "human", command: { type: "retry" } }).success,
    ).toBe(false);
  });
});
