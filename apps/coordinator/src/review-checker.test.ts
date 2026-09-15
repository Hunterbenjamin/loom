import {
  implementationBody,
  latestImplementation,
  whatChanged,
} from "@loom/core";
import { loadScenarios } from "@loom/fake-agent";
import { expect, test } from "vitest";
import { LoomClient } from "./client.js";
import { createHarness, ScenarioDriver } from "./test-support.js";

test.each(["reviewer-checker", "reviewer-inline", "reviewer-dirty"])(
  "%s crosses coordinator observations, MCP, durable storage and the real Git push path",
  async (name) => {
    let h = await createHarness({ serveProtocol: true });
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
      const implementation = latestImplementation(state);
      expect(implementation).toMatchObject({ headSha: head });
      if (!implementation || !state.task.prNumber)
        throw new Error("Missing publication");
      const published = await h.github.readPullRequest(
        h.repo.github,
        state.task.prNumber,
      );
      expect(published.body).toBe(
        implementationBody(state.task, implementation, state.issueKey),
      );
      const client = await LoomClient.connect({
        url: h.coordinator.protocol.url as string,
        token: h.config.token,
        clientId: "implementation-projection",
        kind: "cli",
        subscriptions: [{ kind: "task", taskId: state.task.id }],
      });
      try {
        expect(
          client.state?.collections.inbox.get(state.task.id)?.whatChanged,
        ).toBe(whatChanged(implementation));
      } finally {
        client.close();
      }
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
      const bodyUpdates = h.store.outbox
        .list(task.task.id)
        .filter((row) => row.kind === "update_pr_body");
      expect(bodyUpdates).toHaveLength(1);
      expect(bodyUpdates[0]?.status).toBe("succeeded");
      h = await h.restart();
      await h.coordinator.settle();
      expect(latestImplementation(h.store.loadTaskState(task.task.id))).toEqual(
        implementation,
      );
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
