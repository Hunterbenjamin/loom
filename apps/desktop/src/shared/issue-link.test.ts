import { expect, test } from "vitest";
import { issueFromLink } from "./issue-link.js";

test("issue links accept only local issue navigation", () => {
  expect(issueFromLink("loom://issue/t-96e05833")).toBe("t-96e05833");
  for (const value of [
    "https://example.test/issue/t-96e05833",
    "loom://issue/../../secret",
    "loom://issue/t-96e05833?command=merge",
    "loom://merge/t-96e05833",
  ])
    expect(issueFromLink(value)).toBeNull();
});
