import { describe, expect, it } from "vitest";
import { fixture } from "../test/fixtures.js";
import type { Repo, RepoId, Run, Task, WorktreePath } from "./index.js";
import {
  displayName,
  issueKey,
  parseTaskRef,
  repoKey,
  resolveTaskRef,
  runLabel,
  suggestName,
  truncateName,
} from "./issue-ref.js";

const repo = (id: string, github: string, root = `/tmp/${id}`): Repo => ({
  id: id as RepoId,
  github,
  root: root as WorktreePath,
});
const task = (id: string, repoId: string, number: number): Task => ({
  ...fixture().state.task,
  id: id as Task["id"],
  repoId: repoId as RepoId,
  number,
});

describe("issue identity", () => {
  it("derives repository and issue keys with fallbacks", () => {
    expect(repoKey(repo("r", "owner/loom"))).toBe("LOOM");
    expect(repoKey(repo("r", "owner/123", "/work/My repo"))).toBe("MYREPO");
    expect(repoKey(repo("r", "owner/123", "/123"))).toBe("ISSUE");
    expect(repoKey(repo("r", "owner/long-repository-name"))).toBe("LONGREPO");
    expect(issueKey(repo("r", "owner/loom"), { number: 12 })).toBe("LOOM-12");
  });

  it("creates short display and suggested names", () => {
    expect(truncateName("Short title")).toBe("Short title");
    expect(
      truncateName(
        "A title that is quite a bit longer than thirty two characters",
      ),
    ).toBe("A title that is quite a bit…");
    expect(truncateName("abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "abcdefghijklmnopqrstuvwxyz01234…",
    );
    expect(
      truncateName("This title has trailing punctuation, and keeps going"),
    ).toBe("This title has trailing…");
    expect(displayName({ name: "Chat window", title: "Long title" })).toBe(
      "Chat window",
    );
    expect(suggestName("Chat window (Cmd+J shortcut)")).toBe("Chat window");
  });

  it("labels roles and later rounds", () => {
    expect(
      runLabel({ role: "implementer", round: 0 } as Pick<
        Run,
        "role" | "round"
      >),
    ).toBe("Implementer");
    expect(
      runLabel({ role: "reviewer", round: 2 } as Pick<Run, "role" | "round">),
    ).toBe("Reviewer · round 2");
  });
});

describe("task references", () => {
  it("parses ids, keys and bare numbers", () => {
    expect(parseTaskRef(" 12 ")).toEqual({ number: 12 });
    expect(parseTaskRef("loom-12")).toEqual({ key: "LOOM", number: 12 });
    expect(parseTaskRef("t-036f86ff")).toEqual({ id: "t-036f86ff" });
    expect(parseTaskRef("garbage")).toEqual({ id: "garbage" });
  });

  it("resolves all forms and preserves exact short test ids", () => {
    const repos = [repo("one", "owner/loom")];
    const tasks = [task("t-1", "one", 1), task("t-036f86ff", "one", 12)];
    expect(resolveTaskRef("t-1", { tasks, repos })).toMatchObject({
      ok: true,
      task: tasks[0],
    });
    expect(resolveTaskRef("12", { tasks, repos })).toMatchObject({
      ok: true,
      task: tasks[1],
    });
    expect(resolveTaskRef("loom-12", { tasks, repos })).toMatchObject({
      ok: true,
      task: tasks[1],
    });
  });

  it("reports ambiguity, scope violations and unknown references", () => {
    const repos = [repo("one", "owner/loom"), repo("two", "other/loom")];
    const tasks = [task("t-one", "one", 1), task("t-two", "two", 1)];
    expect(resolveTaskRef("1", { tasks, repos })).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(resolveTaskRef("LOOM-1", { tasks, repos })).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(
      resolveTaskRef("LOOM-1", { tasks, repos, repoId: "one" }),
    ).toMatchObject({
      ok: true,
      task: tasks[0],
    });
    expect(
      resolveTaskRef("t-two", { tasks, repos, repoId: "one" }),
    ).toMatchObject({
      ok: false,
      code: "outside_repo",
    });
    expect(resolveTaskRef("99", { tasks, repos })).toMatchObject({
      ok: false,
      code: "unknown",
    });
  });
});
