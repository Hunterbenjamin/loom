import { expect, test } from "vitest";
import { githubFromOrigin } from "./repository.js";

test.each([
  "git@github.com:owner/project.git",
  "https://github.com/owner/project.git\n",
  "ssh://git@github.com/owner/project",
  "https://github.com/owner/project/",
])("derives owner/name from %s", (remote) => {
  expect(githubFromOrigin(remote)).toBe("owner/project");
});
test.each([
  "/tmp/repo",
  "https://other.example/owner/repo",
  "https://token@github.com/owner/repo",
  "git@github.com:owner/repo\nother",
  null,
])("rejects invalid origin %s", (remote) => {
  expect(() => githubFromOrigin(remote)).toThrow();
});
