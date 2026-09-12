// The fixtures and `packages/protocol` can't drift: this parses the whole converted snapshot with
// the real schemas, and checks the six things the protocol adds over `@loom/core`'s entities.

import {
  applyPatch,
  snapshotBody,
  snapshotFromState,
  snapshotMeta,
  stateFromSnapshot,
  taskInView,
} from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "./index.js";
import { toSnapshot } from "./protocol.js";

const fixture = buildSnapshot();
const { meta, body } = toSnapshot(fixture);

describe("the fixture store as a protocol snapshot", () => {
  it("parses with the real schemas, including through JSON", () => {
    expect(snapshotMeta.parse(meta)).toEqual(meta);
    const parsed = snapshotBody.parse(JSON.parse(JSON.stringify(body)));
    expect(parsed).toEqual(body);
  });

  it("carries every task, run and finding the shell renders", () => {
    expect(body.tasks).toHaveLength(fixture.tasks.length);
    expect(body.runs).toHaveLength(fixture.runs.length);
    expect(body.findings).toHaveLength(fixture.findings.length);
    expect(body.transitions).toHaveLength(fixture.transitions.length);
  });

  it("gives every task a `since` per attention reason", () => {
    const needy = body.tasks.filter((t) => t.attention.reasons.length > 0);
    expect(needy.length).toBeGreaterThan(0);
    for (const task of needy) {
      expect(Object.keys(task.attention.reasonSince).sort()).toEqual(
        [...task.attention.reasons].sort(),
      );
      expect(task.attention.since).toBe(
        [...Object.values(task.attention.reasonSince)].sort()[0],
      );
    }
  });

  it("puts a task ID on messages and test results, so nobody parses a run ID", () => {
    expect(body.messages.every((m) => m.taskId.length > 0)).toBe(true);
    for (const message of body.messages)
      expect(message.runId.startsWith(message.taskId)).toBe(true);
    for (const results of body.testResults)
      expect(results.results.length).toBeGreaterThan(0);
  });

  it("turns the shell's flat comments into threads on findings", () => {
    expect(body.threads.length).toBeGreaterThan(0);
    const ids = new Set(body.findings.map((f) => f.id));
    for (const thread of body.threads) {
      expect(ids.has(thread.findingId)).toBe(true);
      expect(thread.comments.length).toBeGreaterThan(0);
    }
    expect(body.threads.flatMap((t) => t.comments)).toHaveLength(
      fixture.comments.length,
    );
  });

  it("keeps review-shell state per task, with the head it was read at", () => {
    expect(body.reviewStates.length).toBeGreaterThan(0);
    for (const state of body.reviewStates) {
      const worktree = fixture.worktrees.find((w) => w.taskId === state.taskId);
      expect(state.headSha).toBe(worktree?.git?.headSha);
      const viewed = fixture.viewedFiles[state.taskId] ?? [];
      expect(state.viewedFiles.map((f) => f.path)).toEqual(viewed);
    }
  });

  it("models the changed files from Git metadata, not from the patch text", () => {
    const changes = body.changes[0];
    if (!changes) throw new Error("no changed files");
    expect(changes.files).toHaveLength(fixture.patch.files.length);
    const renamed = changes.files.find((f) => f.status === "renamed");
    expect(renamed?.previousPath).toBe("packages/core/src/legacy-stages.ts");
    // The shell's "binary" status is really two facts; the protocol keeps them apart.
    const binary = changes.files.find((f) => f.binary);
    expect(binary?.path).toBe("docs/design/board.png");
    expect(binary?.added).toBeNull();
    expect(new Set(changes.files.map((f) => f.id)).size).toBe(
      changes.files.length,
    );
  });

  it("records which range is under review", () => {
    for (const changes of body.changes) {
      expect(changes.range.mode).toBe("whole_branch");
      expect(changes.range.headSha).not.toBe(changes.range.baseSha);
      expect(changes.id).toBe(`${changes.taskId}#whole_branch`);
    }
  });

  it("gives every live interactive run an attach target and pane state", () => {
    expect(body.runTargets.length).toBeGreaterThan(0);
    for (const target of body.runTargets) {
      expect(target.attach?.argv.length).toBeGreaterThan(0);
      expect(target.attach?.cwd.includes("..")).toBe(false);
      expect(target.pane?.attachedClients).toBeGreaterThanOrEqual(0);
    }
  });

  it("survives a round trip through a client that applies no patches", () => {
    const client = stateFromSnapshot(meta, body);
    expect(
      applyPatch(client, { seq: meta.seq, now: meta.now, changes: [] }).ok,
    ).toBe(false);
    const back = snapshotFromState(client);
    expect(back.tasks).toHaveLength(body.tasks.length);
    expect(back.tasks.filter((t) => taskInView(t, "needs_you")).length).toBe(
      body.tasks.filter((t) => taskInView(t, "needs_you")).length,
    );
  });
});
