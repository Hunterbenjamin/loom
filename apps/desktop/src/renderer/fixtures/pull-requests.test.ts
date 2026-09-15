import { pullRequestDetailRow } from "@loom/protocol";
import { parsePatchFiles } from "@pierre/diffs";
import { expect, test } from "vitest";
import { REVIEW_SECTIONS, reviewGroups } from "../store/pull-requests.js";
import { groupPrFiles, prActivity } from "../ui/pull-request-overview.js";
import { buildSnapshot } from "./index.js";
import { buildPullRequestDetails } from "./pull-requests.js";
import { createFixtureStore } from "./store.js";

test("Reviews fixtures cover every inbox section, completed pagination and Overview/Diff content", () => {
  const fixture = buildSnapshot();
  const state = createFixtureStore(fixture).getState();
  const groups = reviewGroups(state);
  expect(groups.filter((g) => g.count).map((g) => g.id)).toEqual(
    REVIEW_SECTIONS.map((g) => g.id),
  );
  expect(groups.find((g) => g.id === "completed")?.count).toBeGreaterThan(20);
  const details = buildPullRequestDetails(fixture.pullRequests);
  for (const row of details) {
    expect(pullRequestDetailRow.parse(row)).toEqual(row);
    const files = parsePatchFiles(row.patch?.patch ?? "").flatMap(
      (p) => p.files,
    );
    expect(files).toHaveLength(row.detail.changedFiles);
  }
  expect(
    details.some((r) =>
      groupPrFiles(r.detail.files).every((g) => g.files.length),
    ),
  ).toBe(true);
  expect(
    new Set(details.flatMap((r) => prActivity(r.detail).map((a) => a.kind))),
  ).toEqual(new Set(["opened", "commit", "review", "comment", "merged"]));
  expect(details.some((r) => r.detail.requestedReviewers.length)).toBe(true);
  expect(details.some((r) => r.pinned && r.viewedFiles.length)).toBe(true);
  expect(details.some((r) => r.behindBy !== null && r.behindBy > 0)).toBe(true);
  expect(details.some((r) => r.taskId === null)).toBe(true);
  expect(
    details.some((r) =>
      fixture.runs.some(
        (run) => run.taskId === r.taskId && run.status === "working",
      ),
    ),
  ).toBe(true);
});
