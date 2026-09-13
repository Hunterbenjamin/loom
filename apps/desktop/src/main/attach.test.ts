import type { IsoTime, WorktreePath } from "@loom/core";
import type { AckOutcome } from "@loom/protocol";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../shared/connection.js";
import { resolveAttach } from "./attach.js";

const reply = vi.hoisted(() => vi.fn<() => Promise<AckOutcome>>());
vi.mock("../shared/client.js", () => ({
  TrackerClient: class {
    constructor(private options: { onStatus: (status: string) => void }) {}
    start() {
      this.options.onStatus("connected");
    }
    stop() {}
    command = reply;
  },
}));
const config: ConnectionConfig = {
  mode: "live",
  instance: "test",
  dataRoot: "/tmp",
  url: "ws://127.0.0.1:1",
  token: "test-placeholder-only",
};
const requested = {
  hostGeneration: "loom-test#1",
  sessionName: "old-name",
  windowId: "@1",
  paneId: "%1",
};
const renamed = { ...requested, sessionName: "new-name" };
function answer(target = renamed): AckOutcome {
  return {
    ok: true,
    result: {
      kind: "attach_session",
      target: {
        identity: "pane",
        target,
        attach: {
          kind: "pane_host",
          argv: ["tmux"],
          cwd: "/tmp" as WorktreePath,
          env: {},
        },
        pane: {
          ...target,
          dead: false,
          exitStatus: null,
          attachedClients: 0,
          size: null,
          observedAt: "2026-09-13T00:00:00.000Z" as IsoTime,
        },
      },
    },
  };
}
test("reattach accepts a native rename but rejects a different physical pane or generation", async () => {
  reply.mockResolvedValue(answer());
  await expect(resolveAttach(config, requested)).resolves.toMatchObject({
    target: renamed,
  });
  await expect(
    resolveAttach(config, { shellKey: crypto.randomUUID() }),
  ).resolves.toMatchObject({ target: renamed });
  for (const target of [
    { ...renamed, paneId: "%2" },
    { ...renamed, windowId: "@2" },
    { ...renamed, hostGeneration: "loom-test#2" },
    { ...renamed, hostGeneration: "loom-other#1" },
  ]) {
    reply.mockResolvedValue(answer(target));
    await expect(resolveAttach(config, requested)).rejects.toThrow(
      "no live pane",
    );
  }
});
