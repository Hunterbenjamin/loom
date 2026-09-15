import { loadScenarios } from "@loom/fake-agent";
import { expect, test } from "vitest";
import { createHarness, ScenarioDriver } from "./test-support.js";

test.each(["reviewer-checker", "reviewer-inline", "reviewer-dirty"])(
  "%s crosses coordinator observations, MCP, durable storage and the real Git push path",
  async (name) => {
    let h = await createHarness();
    try {
      const task = h.coordinator.createTask({
        repoId: h.repo.id,
        title: "Checker review",
        description: "Correct example.txt",
      });
      h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
      const walking = await loadScenarios(
        new URL("./fixtures/walking-skeleton.json", import.meta.url),
      );
      const planner = walking[0];
      if (!planner) throw new Error("Missing planner fixture");
      const review = await loadScenarios(
        new URL(
          `../../../packages/fake-agent/src/fixtures/${name}.json`,
          import.meta.url,
        ),
      );
      for (const scenario of review) scenario.agent.mode = "interactive";
      await new ScenarioDriver(h, [planner, ...review]).run();
      await h.coordinator.settle();
      const state = h.store.loadTaskState(task.task.id);
      if (name !== "reviewer-checker") {
        // A dirty tree or a reviewer's own fix commit is refused; nothing is published.
        expect(state.task.stage).toBe("in_review");
        expect(state.review?.publicationPending).toBeUndefined();
        expect(state.findings).toEqual([]);
        return;
      }
      const head = state.review?.lastReviewedHead;
      expect(state.task.stage).toBe("awaiting_approval");
      expect(state.task.reviewRound).toBe(1);
      expect(state.review?.headSha).toBe(head);
      expect(state.review?.reviewerCommits).toEqual([]);
      expect(state.findings).toMatchObject([
        { status: "open", blocking: false, source: "reviewer" },
      ]);
      expect(
        await h.git("rev-parse", `refs/remotes/origin/${state.task.branch}`),
      ).toBe(head);
      expect(h.github.snapshot()?.headSha).toBe(head);
      expect(state.artifactContents.handoff).toMatchObject({
        reviewerSubmission: {
          input: { reviewedSha: head, reviewerCommits: [] },
        },
      });
      // The CI gate pushed the submitted head once; publication reuses that push.
      const pushes = h.store.outbox
        .list(task.task.id)
        .filter((row) => row.kind === "push_branch");
      expect(pushes).toHaveLength(1);
      expect(pushes.every((row) => row.status === "succeeded")).toBe(true);
      h = await h.restart();
      await h.coordinator.settle();
      expect(h.store.loadTaskState(task.task.id).review).toEqual(state.review);
      expect(
        h.store.outbox
          .list(task.task.id)
          .filter((row) => row.kind === "push_branch"),
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
  60000,
);

test.each([false, true])(
  "base movement after approval routes in code (conflicting=%s)",
  async (conflicting) => {
    let h = await createHarness();
    try {
      const { task } = h.coordinator.createTask({
        repoId: h.repo.id,
        title: "Base movement",
        description: "Correct example.txt",
      });
      h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
      const walking = await loadScenarios(
        new URL("./fixtures/walking-skeleton.json", import.meta.url),
      );
      const planner = walking[0];
      if (!planner) throw new Error("Missing planner");
      const review = await loadScenarios(
        new URL(
          "../../../packages/fake-agent/src/fixtures/reviewer-checker.json",
          import.meta.url,
        ),
      );
      for (const scenario of review) scenario.agent.mode = "interactive";
      await new ScenarioDriver(h, [planner, ...review]).run();
      await h.coordinator.settle();
      const before = h.store.loadTaskState(task.id);
      const worktree = before.worktree;
      if (!worktree) throw new Error("Missing worktree");
      expect(before.task.stage).toBe("awaiting_approval");
      const base = await h.commitIn(
        h.repoRoot,
        { [conflicting ? "example.txt" : "independent.txt"]: "main moved\n" },
        "Move base",
      );
      await h.git("push", "origin", "main");
      h.coordinator.loop.enqueue(task.id);
      await h.coordinator.settle();
      const after = h.store.loadTaskState(task.id);
      expect(after.task.failed).toBeNull();
      if (conflicting) {
        expect(after.task.stage).toBe("in_progress");
        expect(
          after.runs.filter((r) => r.role === "implementer").at(-1)?.fixReason,
        ).toContain("Merge main");
        expect(after.task.reviewRound).toBe(before.task.reviewRound);
        expect(
          h.store.outbox.list(task.id).some((r) => r.kind === "merge_base"),
        ).toBe(false);
      } else {
        const git = await h.adapters.git.readWorktree(worktree.path, "main", [
          base,
        ]);
        expect(git.reachableCommits, h.logs.join("\n")).toContain(base);
        expect(git.remoteHeadSha).toBe(git.headSha);
        expect(
          after.runs.filter((r) => r.role === "implementer").map((r) => r.id),
        ).toEqual(
          before.runs.filter((r) => r.role === "implementer").map((r) => r.id),
        );
        expect(["ci", "in_review"]).toContain(after.task.stage);
        const merges = h.store.outbox
          .list(task.id)
          .filter((r) => r.kind === "merge_base");
        expect(merges).toHaveLength(1);
        expect(merges[0]?.status).toBe("succeeded");
        expect(
          h.store.outbox
            .list(task.id)
            .find(
              (row) =>
                row.action?.kind === "push_branch" &&
                row.action.expectedHeadSha === git.headSha,
            )?.action,
        ).toMatchObject({ nonForce: true });
        h = await h.restart();
        await h.coordinator.settle();
        expect(
          h.store.outbox.list(task.id).filter((r) => r.kind === "merge_base"),
        ).toHaveLength(1);
        expect(h.store.loadTaskState(task.id).review?.baseSyncRounds).toBe(
          after.review?.baseSyncRounds,
        );
      }
    } finally {
      await h.close();
    }
  },
  60000,
);
