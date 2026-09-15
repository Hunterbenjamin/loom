// @vitest-environment happy-dom
import {
  type AckOutcome,
  type PullRequestDetailRow,
  stateFromSnapshot,
} from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { buildPullRequestDetails } from "../fixtures/pull-requests.js";
import { pullRequestSubscriptions } from "../store/pull-requests.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Detail } from "./detail.js";
import { useShortcuts } from "./keys.js";
import { Palette } from "./palette.js";
import { PullRequestDetail } from "./pull-request-detail.js";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: unknown) => {
    viewer(props);
    const ref = (props as { ref?: { current: unknown } }).ref;
    if (ref) ref.current = { scrollTo: scroll };
    const p = props as {
      items: import("@pierre/diffs").CodeViewItem<undefined>[];
      renderCustomHeader?: (
        item: import("@pierre/diffs").CodeViewItem<undefined>,
      ) => import("react").ReactNode;
    };
    return createElement(
      "div",
      { "data-testid": "pierre" },
      p.items.map((i) =>
        createElement("div", { key: i.id }, p.renderCustomHeader?.(i)),
      ),
    );
  },
}));
const viewer = vi.fn();
const scroll = vi.fn();
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  viewer.mockClear();
  scroll.mockClear();
});
function setup(change: Partial<PullRequestDetailRow["detail"]> = {}) {
  const fixture = buildSnapshot();
  const row = buildPullRequestDetails(fixture.pullRequests)[0];
  if (!row) throw new Error("Missing fixture");
  row.detail = { ...row.detail, ...change };
  // Direct GitHub actions belong only to PRs without an issue.
  row.taskId = null;
  const store = createStore(fixture, true);
  store.setConnection("connected");
  const selection = { repoId: row.repoId, number: row.number };
  const wire = toSnapshot(fixture);
  const update = () =>
    store.applyProtocol(
      stateFromSnapshot(wire.meta, {
        ...wire.body,
        pullRequestDetails: [structuredClone(row)],
      }),
    );
  update();
  store.openPullRequest(selection);
  const sender = vi.fn(
    async (
      _command: import("@loom/protocol").Command,
    ): Promise<AckOutcome> => ({
      ok: true,
      result: {
        kind: "pull_request_action",
        command: "merge_pull_request",
        ...selection,
      },
    }),
  );
  store.setSender(sender);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Keyboard() {
    useShortcuts(store);
    return null;
  }
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: [
          createElement(Keyboard, { key: "keys" }),
          createElement(Palette, { key: "palette" }),
          createElement(PullRequestDetail, { key: "detail", selection }),
        ],
      }),
    ),
  );
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  const button = (text: string) => {
    const match = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
    if (!match) throw new Error(`Missing button ${text}`);
    return match;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  return { host, store, row, sender, update, button, click, root, fixture };
}

test.each([
  [{ checks: "pending" }, "Checks are pending."],
  [{ checks: "failure" }, "Checks have failed."],
  [{ mergeable: "unknown" }, "Mergeability is not yet known."],
  [{ mergeable: "conflicting" }, "Resolve merge conflicts first."],
  [{ draft: true }, "The pull request is a draft."],
] as const)(
  "merge remains visible and explains refusal %j",
  (change, reason) => {
    const h = setup(change);
    expect(h.button("Squash & merge").disabled).toBe(true);
    expect(h.host.textContent).toContain(reason);
    expect(h.sender).not.toHaveBeenCalled();
  },
);

test("a merged pull request omits redundant merge status and action", () => {
  const h = setup({ state: "merged" });
  expect(h.host.textContent).not.toContain("The pull request is not open.");
  expect(h.host.textContent).not.toContain("Merged at");
  expect(
    [...h.host.querySelectorAll("button")].some(
      (button) => button.textContent === "Squash & merge",
    ),
  ).toBe(false);
});

test("a closed pull request omits the redundant non-open message but preserves connection errors", () => {
  const h = setup({ state: "closed" });
  expect(h.host.textContent).not.toContain("The pull request is not open.");
  expect(h.button("Squash & merge").disabled).toBe(true);
  act(() => h.store.setConnection("disconnected"));
  expect(h.host.textContent).toContain("Disconnected from the coordinator.");
});

test.each(["success", "none"] as const)(
  "confirms exact head and base, default deletion, and refreshed outcomes with %s checks",
  async (checks) => {
    const h = setup({ checks });
    h.sender.mockImplementation(async () => {
      h.row.detail.state = "merged";
      h.row.detail.mergedAt = h.row.detail.observedAt;
      h.row.detail.branchExists = false;
      h.update();
      return {
        ok: true,
        result: {
          kind: "pull_request_action",
          command: "merge_pull_request",
          repoId: h.row.repoId,
          number: h.row.number,
        },
      };
    });
    expect(h.button("Squash & merge").disabled).toBe(false);
    expect(h.button("Delete branch").disabled).toBe(true);
    await h.click("Squash & merge");
    const dialog = h.host.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain(h.row.detail.headSha);
    expect(dialog?.textContent).toContain(h.row.detail.base);
    expect(
      dialog?.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')
        ?.checked,
    ).toBe(true);
    expect(h.sender).not.toHaveBeenCalled();
    await h.click("Confirm squash merge");
    expect(h.sender).toHaveBeenCalledExactlyOnceWith({
      kind: "merge_pull_request",
      repoId: h.row.repoId,
      number: h.row.number,
      matchHeadSha: h.row.detail.headSha,
      deleteBranch: true,
    });
    expect(h.host.textContent).not.toContain("Merged at");
    expect(
      [...h.host.querySelectorAll("button")].some(
        (button) => button.textContent === "Squash & merge",
      ),
    ).toBe(false);
    expect(h.host.textContent).toContain("Branch deleted.");
    expect(h.button("Delete branch").disabled).toBe(true);
  },
);

test("cancel sends nothing; unchecking deletion reaches the command and GitHub errors stay inline", async () => {
  const h = setup();
  await h.click("Squash & merge");
  await h.click("Cancel");
  expect(h.sender).not.toHaveBeenCalled();
  await h.click("Squash & merge");
  act(() =>
    h.host
      .querySelector<HTMLInputElement>('dialog input[type="checkbox"]')
      ?.click(),
  );
  h.sender.mockResolvedValue({
    ok: false,
    error: {
      code: "guard_failed",
      message: "GitHub head changed",
      details: [],
    },
  });
  await h.click("Confirm squash merge");
  expect(h.sender.mock.calls[0]?.[0]).toMatchObject({ deleteBranch: false });
  expect(h.host.textContent).toContain("GitHub head changed");
});

test("a push invalidates an open confirmation instead of silently approving the new head", async () => {
  const h = setup();
  await h.click("Squash & merge");
  act(() => {
    h.row.detail.headSha = "b".repeat(40) as typeof h.row.detail.headSha;
    h.update();
  });
  expect(h.button("Confirm squash merge").disabled).toBe(true);
  expect(h.host.textContent).toContain("The head or base changed.");
  await h.click("Confirm squash merge");
  expect(h.sender).not.toHaveBeenCalled();
});

test.each(["merged", "closed"] as const)(
  "deletion needs an existing branch on a %s PR",
  async (state) => {
    const h = setup({ state, branchExists: true });
    expect(h.button("Delete branch").disabled).toBe(false);
    await h.click("Delete branch");
    expect(h.sender).toHaveBeenCalledWith({
      kind: "delete_branch",
      repoId: h.row.repoId,
      number: h.row.number,
    });
    for (const branchExists of [false, null]) {
      act(() => {
        h.row.detail.branchExists = branchExists;
        h.update();
      });
      expect(h.button("Delete branch").disabled).toBe(true);
    }
  },
);

test("close confirms, refresh routes through coordinator, and disconnected actions are disabled", async () => {
  const h = setup();
  await h.click("Close");
  expect(h.sender).not.toHaveBeenCalled();
  await h.click("Confirm close");
  expect(h.sender).toHaveBeenCalledWith({
    kind: "close_pull_request",
    repoId: h.row.repoId,
    number: h.row.number,
  });
  await h.click("Refresh");
  expect(h.sender).toHaveBeenCalledWith({
    kind: "refresh_pull_requests",
    repoId: h.row.repoId,
    state: "open",
  });
  act(() => h.store.setConnection("disconnected"));
  for (const label of ["Squash & merge", "Delete branch", "Close", "Refresh"])
    expect(h.button(label).disabled).toBe(true);
});

test("renders markdown safely, every check with duration/link, commits, and read-only Pierre patches", async () => {
  const h = setup({
    body: "## Description\n\n**Bold** and `code`\n\n<script>bad()</script>\n\n[unsafe](javascript:alert(1))",
  });
  expect(h.host.querySelector(".pr-markdown h2")?.textContent).toBe(
    "Description",
  );
  expect(h.host.querySelector("strong")?.textContent).toBe("Bold");
  expect(h.host.querySelector("script")).toBeNull();
  expect(h.host.querySelector('a[href^="javascript:"]')).toBeNull();
  await act(async () =>
    h.host.querySelector<HTMLElement>(".pr-checks summary")?.click(),
  );
  expect(h.host.textContent).toContain("completed · success");
  expect(h.host.textContent).toContain("2m 0s");
  expect(h.host.querySelector(".pr-data a")?.getAttribute("href")).toBe(
    h.row.detail.checkRuns[0]?.url,
  );

  expect(h.host.querySelector(".pr-commit")?.textContent).toContain(
    h.row.detail.headSha.slice(0, 7),
  );
  await act(async () => {
    await import("./pull-request-diff.js");
  });
  await h.click("Diff");
  expect(h.host.textContent).toContain("Files");
  const first = viewer.mock.lastCall?.[0] as {
    items: { version: number; fileDiff: unknown }[];
    options: { enableLineSelection: boolean };
    renderAnnotation?: unknown;
  };
  expect(first.options.enableLineSelection).toBe(false);
  expect(first.renderAnnotation).toBeUndefined();
  expect(first.items).toHaveLength(1);
  act(() => {
    if (!h.row.patch) throw new Error("Expected patch");
    h.row.patch.patch = h.row.patch.patch.replace(`= ${h.row.number}`, "= 999");
    h.update();
  });
  const second = viewer.mock.lastCall?.[0] as typeof first;
  expect(second.items[0]?.version).not.toBe(first.items[0]?.version);
  act(() => {
    if (!h.row.patch) throw new Error("Expected patch");
    h.row.patch.truncated = true;
    h.update();
  });
  expect(h.host.textContent).toContain("truncated");
  expect(h.host.textContent).toContain("No complete file diff");
  act(() => {
    if (!h.row.patch) throw new Error("Expected patch");
    h.row.patch.truncated = false;
    if (!h.row.patch) throw new Error("Expected patch");
    h.row.patch.patch = "invalid patch";
    h.update();
  });
  expect(h.host.textContent).toContain("No complete file diff");
});

test("detail scopes follow selection and visibility, task PR links open in-app", () => {
  const h = setup();
  act(() => h.store.setTrackerVisible(true));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([
    { kind: "pull_request", repoId: h.row.repoId, number: h.row.number },
    { kind: "pull_requests", repoId: h.row.repoId, state: "open" },
  ]);
  act(() => h.store.setTrackerVisible(false));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([
    { kind: "pull_requests", repoId: h.row.repoId, state: "open" },
  ]);
  const task = h.fixture.tasks[0];
  if (!task) throw new Error("Missing task");
  act(() => {
    h.store.open(task.id);
    h.root.render(
      createElement(StoreProvider, {
        store: h.store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: createElement(Detail, {
          task: { ...task, prNumber: h.row.number },
        }),
      }),
    );
  });
  expect(h.store.getState().ui.openPr).toBeNull();
  act(() => h.button(`PR #${h.row.number}`).click());
  expect(h.store.getState().ui.openTask).toBeNull();
  expect(h.store.getState().ui.openPr).toEqual({
    repoId: task.repoId,
    number: h.row.number,
  });
});

function press(
  key: string,
  target: EventTarget = window,
  extra: KeyboardEventInit = {},
) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  });
}

test("PR shortcuts reuse confirmation and guarded controls, while typing and dialogs retain their keys", async () => {
  const h = setup();
  const link = h.host.querySelector<HTMLAnchorElement>(
    '[data-pr-action="open"]',
  );
  if (!link) throw new Error("Missing GitHub link");
  const open = vi.spyOn(link, "click").mockImplementation(() => {});
  press("o");
  expect(open).toHaveBeenCalledOnce();
  press("d");
  expect(h.sender).not.toHaveBeenCalled();
  const input = document.createElement("input");
  h.host.append(input);
  for (const key of ["m", "d", "o", "r"]) press(key, input);
  press("m", window, { ctrlKey: true });
  press("m", window, { repeat: true });
  expect(h.host.querySelector("dialog")).toBeNull();
  expect(h.sender).not.toHaveBeenCalled();
  press("m");
  expect(h.host.querySelector("dialog")?.open).toBe(true);
  expect(h.host.querySelector("dialog")?.textContent).toContain(
    h.row.detail.headSha,
  );
  press("r");
  press("o");
  expect(h.sender).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledOnce();
  await h.click("Cancel");
  await act(async () => press("r"));
  expect(h.sender).toHaveBeenCalledExactlyOnceWith({
    kind: "refresh_pull_requests",
    repoId: h.row.repoId,
    state: "open",
  });
  h.sender.mockClear();
  act(() => {
    h.row.detail.state = "merged";
    h.update();
  });
  press("m");
  expect(h.host.querySelector("dialog")).toBeNull();
  await act(async () => press("d"));
  expect(h.sender).toHaveBeenCalledExactlyOnceWith({
    kind: "delete_branch",
    repoId: h.row.repoId,
    number: h.row.number,
  });
  h.sender.mockClear();
  act(() => h.store.setConnection("disconnected"));
  await act(async () => {
    press("d");
    press("r");
  });
  expect(h.sender).not.toHaveBeenCalled();
});

test("palette exposes PR actions and disabled reasons, and merge opens the same confirmation", async () => {
  const h = setup({ checks: "pending" });
  act(() => h.store.setPalette(true));
  const item = (action: string) => {
    const element = h.host.querySelector<HTMLElement>(
      `[cmdk-item][data-value^="pull-request-${action} "]`,
    );
    if (!element) throw new Error(`Missing palette command ${action}`);
    return element;
  };
  expect(item("merge").getAttribute("aria-disabled")).toBe("true");
  expect(item("merge").title).toBe("Checks are pending.");
  expect(item("delete").getAttribute("aria-disabled")).toBe("true");
  expect(item("open").textContent).toContain("o");
  expect(item("refresh").textContent).toContain("r");
  press("m", h.host.querySelector("input") ?? window);
  expect(h.host.querySelector("dialog")).toBeNull();
  act(() => {
    h.row.detail.checks = "success";
    h.update();
  });
  await act(async () => item("merge").click());
  expect(h.store.getState().ui.palette).toBe(false);
  expect(h.host.querySelector("dialog")?.open).toBe(true);
  expect(h.sender).not.toHaveBeenCalled();
  await h.click("Confirm squash merge");
  expect(h.sender).toHaveBeenCalledOnce();
});

test("a pending command cannot be submitted again through shortcuts or the palette", async () => {
  const h = setup({ state: "closed" });
  let finish!: (outcome: AckOutcome) => void;
  h.sender.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  press("d");
  press("d");
  act(() => h.store.setPalette(true));
  act(() =>
    h.host
      .querySelector<HTMLElement>(
        '[cmdk-item][data-value^="pull-request-delete "]',
      )
      ?.click(),
  );
  expect(h.sender).toHaveBeenCalledOnce();
  await act(async () =>
    finish({
      ok: false,
      error: { code: "guard_failed", message: "Branch protected", details: [] },
    }),
  );
});

test("opening a linked issue retains issue palette commands over the PR list", () => {
  const h = setup();
  const task = h.fixture.tasks[0];
  if (!task) throw new Error("Missing issue");
  act(() => {
    h.store.setView("pull-requests");
    h.store.open(task.id);
    h.store.setPalette(true);
  });
  expect(h.host.querySelector("[cmdk-root]")?.textContent).toContain(
    "Review changes and findings",
  );
  expect(
    h.host.querySelector('[data-value^="pull-request-merge "]'),
  ).toBeNull();
});

test("description renders while the diff is loading, and a diff error leaves it readable", async () => {
  const h = setup({ body: "Overview arrives first" });
  act(() => {
    h.row.patch = null;
    h.row.patchLoading = true;
    h.update();
  });
  expect(h.host.textContent).toContain("Overview arrives first");
  await h.click("Diff");
  expect(h.host.textContent).toContain("Loading diff…");
  expect(viewer).not.toHaveBeenCalled();
  act(() => {
    h.row.patchLoading = false;
    h.row.patchError = "Could not load the diff. Refresh to retry.";
    h.update();
  });
  expect(h.host.textContent).toContain("Refresh to retry");
  await h.click("Overview");
  expect(h.host.textContent).toContain("Overview arrives first");
});

test("Overview keeps the reference rail order, grouped counts, and file-to-Diff navigation", async () => {
  const h = setup({
    requestedReviewers: ["reviewer"],
    files: [
      {
        path: "src/feature.ts",
        additions: 5,
        deletions: 2,
        changeType: "MODIFIED",
      },
      {
        path: "src/feature.test.ts",
        additions: 3,
        deletions: 0,
        changeType: "ADDED",
      },
      {
        path: "tests/helpers.ts",
        additions: 2,
        deletions: 1,
        changeType: "MODIFIED",
      },
    ],
    changedFiles: 3,
  });
  expect(
    [...h.host.querySelectorAll('[role="tab"]')].map((el) => el.textContent),
  ).toEqual(["Overview", "Diff"]);
  expect(
    [...h.host.querySelectorAll(".pr-rail h3")].map((el) => el.textContent),
  ).toEqual([
    "Status",
    "Resolves",
    "Reviewers",
    "Checks",
    "Branch",
    "3 files changed",
  ]);
  expect(h.host.querySelector(".pr-file-groups")?.textContent).toContain(
    "Implementation 1",
  );
  expect(h.host.querySelector(".pr-file-groups")?.textContent).toContain(
    "Tests 2",
  );
  expect(h.host.querySelector(".pr-rail")?.textContent).toContain("reviewer");
  expect(
    h.host.querySelector<HTMLButtonElement>(
      '[title="Adding reviewers is not available in v1"]',
    )?.disabled,
  ).toBe(true);
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>('[title="src/feature.ts"]')
      ?.click(),
  );
  expect(
    h.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("Diff");
});

test("pin waits for the coordinator projection and the split option controls merge confirmation", async () => {
  const h = setup();
  const pin = h.host.querySelector<HTMLButtonElement>(
    '[aria-label="Pin pull request"]',
  );
  await act(async () => pin?.click());
  expect(h.sender).toHaveBeenCalledWith({
    kind: "pin_pull_request",
    repoId: h.row.repoId,
    number: h.row.number,
    pinned: true,
  });
  expect(pin?.getAttribute("aria-pressed")).toBe("false");
  act(() => {
    h.row.pinned = true;
    h.update();
  });
  expect(
    h.host
      .querySelector('[aria-label="Unpin pull request"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  act(() =>
    h.host
      .querySelector<HTMLInputElement>('.pr-merge-split input[type="checkbox"]')
      ?.click(),
  );
  await h.click("Squash & merge");
  expect(
    h.host.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')
      ?.checked,
  ).toBe(false);
  await h.click("Confirm squash merge");
  expect(h.sender.mock.lastCall?.[0]).toMatchObject({
    kind: "merge_pull_request",
    deleteBranch: false,
  });
});

test("comment errors keep the draft and retry identity, while acknowledgement clears it", async () => {
  const h = setup();
  const area = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="PR comment"]',
  );
  if (!area) throw new Error("Missing comment box");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(area, "A considered comment");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  h.sender.mockResolvedValue({
    ok: false,
    error: { code: "unavailable", message: "Connection lost", details: [] },
  });
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>('[aria-label="Post comment"]')
      ?.click(),
  );
  const command = h.sender.mock.lastCall?.[0];
  expect(command).toMatchObject({
    kind: "comment_pull_request",
    body: "A considered comment",
  });
  expect(area.value).toBe("A considered comment");
  h.sender.mockResolvedValue({
    ok: true,
    result: {
      kind: "pull_request_action",
      command: "comment_pull_request",
      repoId: h.row.repoId,
      number: h.row.number,
    },
  });
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>('[aria-label="Post comment"]')
      ?.click(),
  );
  expect(h.sender.mock.lastCall?.[0]).toEqual(command);
  expect(area.value).toBe("");
});

test("file selection scrolls the existing viewer after a delayed patch arrives", async () => {
  const h = setup();
  const patch = h.row.patch;
  act(() => {
    h.row.patch = null;
    h.row.patchLoading = true;
    h.update();
  });
  await act(async () =>
    h.host.querySelector<HTMLButtonElement>('[title="example.ts"]')?.click(),
  );
  expect(h.host.textContent).toContain("Loading diff");
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => {
    h.row.patch = patch;
    h.row.patchLoading = false;
    h.update();
  });
  expect(scroll).toHaveBeenCalledWith({
    type: "item",
    id: "example.ts",
    align: "start",
  });
});

test("linking a PR opens the issue Plan and overview, without direct merge", async () => {
  const h = setup();
  const issue = h.fixture.tasks.find((task) => h.fixture.plans[task.id]);
  if (!issue) throw new Error("Missing issue");
  act(() => {
    h.row.taskId = issue.id;
    h.update();
  });
  expect(h.host.querySelector('[data-testid="detail"]')).not.toBeNull();
  expect(h.host.querySelectorAll(".pr-story")).toHaveLength(1);
  expect(h.host.querySelectorAll(".pr-rail")).toHaveLength(1);
  expect(h.host.textContent).toContain(issue.description);
  expect(h.host.textContent).not.toContain("Keeps GitHub as the owner.");
  expect(h.host.textContent).toContain("What changed");
  const descriptions = [...h.host.querySelectorAll(".pr-story h3")].filter(
    (heading) => heading.textContent === "Description",
  );
  expect(descriptions).toHaveLength(1);
  const updateImplementation = (whatChanged: string) => {
    const wire = toSnapshot(h.fixture);
    act(() =>
      h.store.applyProtocol(
        stateFromSnapshot(wire.meta, {
          ...wire.body,
          pullRequestDetails: [structuredClone(h.row)],
          inbox: [
            {
              taskId: issue.id,
              whatChanged,
              reasonRuns: {},
              reviewedHead: null,
              planVersion: null,
              workTime: { startedAt: null, readyAt: null },
            },
          ],
        }),
      ),
    );
  };
  updateImplementation(
    "Initial implementation.\n\n### Deviations\n\nKept the shared layout.",
  );
  expect(h.host.textContent).toContain("Initial implementation.");
  expect(h.host.textContent).toContain("Kept the shared layout.");
  updateImplementation("Complete implementation including the fix.");
  expect(h.host.textContent).not.toContain("Initial implementation.");
  expect(h.host.textContent).toContain(
    "Complete implementation including the fix.",
  );
  expect(h.host.textContent).toContain(issue.description);
  expect(h.host.textContent).not.toContain("Squash & merge");
  await h.click("Plan");
  expect(h.host.textContent).toContain(h.fixture.plans[issue.id]?.goal);
  await h.click("Diff");
  expect(h.store.getState().ui.tab).toBe("diff");
});

test("Diff uses rail order, unified cards, durable Reviewed marks and file/hunk keys", async () => {
  const h = setup();
  const testFile = {
    path: "tests/example.test.ts",
    additions: 2,
    deletions: 0,
    changeType: "ADDED" as const,
  };
  act(() => {
    h.row.detail.files.unshift(testFile);
    h.row.detail.changedFiles = 2;
    h.update();
  });
  await act(async () => {
    await import("./pull-request-diff.js");
  });
  await h.click("Diff");
  type Viewer = {
    items: import("@pierre/diffs").CodeViewItem<undefined>[];
    options: {
      diffStyle: string;
      hunkSeparators: string;
      loadDiffFiles: (...args: never[]) => unknown;
    };
  };
  const before = viewer.mock.lastCall?.[0] as Viewer;
  expect(before.items.map((i) => i.id)).toEqual(["example.ts", testFile.path]);
  expect(before.options.diffStyle).toBe("unified");
  expect(before.options.hunkSeparators).toBe("line-info");
  expect(before.options.loadDiffFiles).toBeTypeOf("function");
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "]" })),
  );
  expect(scroll).toHaveBeenCalledWith(
    expect.objectContaining({ type: "line", id: "example.ts", lineNumber: 1 }),
  );
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" })),
  );
  expect(h.sender.mock.lastCall?.[0]).toMatchObject({
    kind: "save_review_state",
    repoId: h.row.repoId,
    number: h.row.number,
    change: {
      headSha: h.row.detail.headSha,
      viewed: [
        {
          fileId: "example.ts",
          path: "example.ts",
          headSha: h.row.detail.headSha,
        },
      ],
    },
  });
  // An ack alone cannot manufacture persisted state; the coordinator patch owns it.
  expect(
    (viewer.mock.lastCall?.[0] as Viewer | undefined)?.items[0]?.collapsed,
  ).toBe(false);
  act(() => {
    h.row.viewedFiles = [
      {
        fileId: "example.ts",
        path: "example.ts",
        headSha: h.row.detail.headSha,
        at: h.row.detail.observedAt,
      },
    ];
    h.update();
  });
  expect(
    (viewer.mock.lastCall?.[0] as Viewer | undefined)?.items[0]?.collapsed,
  ).toBe(true);
  expect(
    (viewer.mock.lastCall?.[0] as Viewer | undefined)?.items[0]?.version,
  ).not.toBe(before.items[0]?.version);
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })),
  );
  expect(scroll).toHaveBeenCalledWith({
    type: "item",
    id: testFile.path,
    align: "start",
  });
  await h.click("Overview");
  await h.click("Diff");
  expect(
    (
      h.host.querySelector(
        '[aria-label="Reviewed example.ts"]',
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
  act(() => {
    h.row.detail.headSha = "f".repeat(40) as typeof h.row.detail.headSha;
    h.row.patch = null;
    h.update();
  });
  expect(
    (viewer.mock.lastCall?.[0] as Viewer | undefined)?.items[0]?.collapsed,
  ).toBe(false);
});

test("Commits requests the selected commit, disables whole-PR marks, and Files restores the full diff", async () => {
  const h = setup();
  await act(async () => {
    await import("./pull-request-diff.js");
  });
  await h.click("Diff");
  const commitButton = () =>
    h.host.querySelector<HTMLButtonElement>(".pr-diff-commits button");
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>(
        '[role="tablist"][aria-label="Diff range"] button:last-child',
      )
      ?.click(),
  );
  h.sender.mockImplementation(async () => ({
    ok: true,
    result: {
      kind: "pull_request_commit",
      diff: {
        files: h.row.detail.files,
        patch: h.row.patch as NonNullable<typeof h.row.patch>,
      },
    },
  }));
  await act(async () => commitButton()?.click());
  expect(h.sender.mock.lastCall?.[0]).toMatchObject({
    kind: "fetch_pull_request_commit",
    headSha: h.row.detail.headSha,
    commitSha: h.row.detail.commits[0]?.sha,
  });
  expect(
    (
      h.host.querySelector(
        '[aria-label="Reviewed example.ts"]',
      ) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>(
        '[role="tablist"][aria-label="Diff range"] button:first-child',
      )
      ?.click(),
  );
  expect(
    (
      h.host.querySelector(
        '[aria-label="Reviewed example.ts"]',
      ) as HTMLInputElement
    ).disabled,
  ).toBe(false);
});

test("whitespace setting reads coordinator-filtered patches and keeps native expansion available", async () => {
  const h = setup();
  await act(async () => {
    await import("./pull-request-diff.js");
  });
  await h.click("Diff");
  h.sender.mockImplementation(async () => ({
    ok: true,
    result: {
      kind: "pull_request_file",
      contents: {
        old: "old\n",
        new: "new\n",
        patch: "--- example.ts\n+++ example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
    },
  }));
  await act(async () =>
    h.host
      .querySelector<HTMLInputElement>('.pr-diff-bar input[type="checkbox"]')
      ?.click(),
  );
  expect(h.sender.mock.lastCall?.[0]).toMatchObject({
    kind: "fetch_pull_request_file",
    path: "example.ts",
    commitSha: null,
    ignoreWhitespace: true,
    headSha: h.row.detail.headSha,
  });
  const props = viewer.mock.lastCall?.[0] as {
    items: import("@pierre/diffs").CodeViewItem<undefined>[];
    options: {
      loadDiffFiles(
        file: import("@pierre/diffs").FileDiffMetadata,
      ): Promise<unknown>;
    };
  };
  const item = props.items[0];
  expect(item?.type).toBe("diff");
  if (item?.type !== "diff") throw new Error("Expected diff");
  expect(item.fileDiff.additionLines.join("")).toContain("new");
  await act(async () => {
    await expect(
      props.options.loadDiffFiles(item.fileDiff),
    ).resolves.toMatchObject({
      oldFile: { contents: "old\n" },
      newFile: { contents: "new\n" },
    });
  });
});

test("Cmd+Enter opens exact-head confirmation from Overview inputs and Diff without submitting", async () => {
  const h = setup();
  const comment = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="PR comment"]',
  );
  if (!comment) throw new Error("Missing comment box");
  comment.focus();
  press("Enter", comment, { metaKey: true });
  expect(h.host.querySelector("dialog")?.open).toBe(true);
  expect(h.host.querySelector("dialog")?.textContent).toContain(
    h.row.detail.headSha,
  );
  expect(h.sender).not.toHaveBeenCalled();
  press("Enter", comment, { metaKey: true });
  expect(h.sender).not.toHaveBeenCalled();
  await h.click("Cancel");
  expect(document.activeElement).toBe(comment);
  await act(async () => {
    await import("./pull-request-diff.js");
  });
  await h.click("Diff");
  press("Enter", h.host.querySelector('[data-testid="pierre"]') ?? window, {
    metaKey: true,
  });
  expect(h.host.querySelector("dialog")?.open).toBe(true);
  expect(h.sender).not.toHaveBeenCalled();
  act(() => {
    h.row.detail.headSha = "f".repeat(40) as typeof h.row.detail.headSha;
    h.update();
  });
  expect(h.button("Confirm squash merge").disabled).toBe(true);
  await h.click("Cancel");
  press("Enter", window, { metaKey: true });
  await h.click("Confirm squash merge");
  expect(h.sender).toHaveBeenCalledExactlyOnceWith({
    kind: "merge_pull_request",
    repoId: h.row.repoId,
    number: h.row.number,
    matchHeadSha: h.row.detail.headSha,
    deleteBranch: true,
  });
});

test("Cmd+Enter respects merge guards, palette, composition, repeated keys and other chords", async () => {
  const h = setup({ checks: "pending" });
  press("Enter", window, { metaKey: true });
  expect(h.host.querySelector("dialog")).toBeNull();
  act(() => {
    h.row.detail.checks = "success";
    h.update();
  });
  for (const extra of [
    { repeat: true },
    { isComposing: true },
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
  ]) {
    press("Enter", window, { metaKey: true, ...extra });
    expect(h.host.querySelector("dialog")).toBeNull();
  }
  act(() => h.store.setPalette(true));
  press("Enter", window, { metaKey: true });
  expect(h.host.querySelector("dialog")).toBeNull();
  act(() => {
    h.store.setPalette(false);
    h.store.setConnection("disconnected");
  });
  press("Enter", window, { metaKey: true });
  expect(h.host.querySelector("dialog")).toBeNull();
  expect(h.sender).not.toHaveBeenCalled();
});

test("issue detail opens durable explicit PR links without a PR list cache and deduplicates its branch PR", () => {
  const h = setup();
  const task = h.fixture.tasks[0];
  if (!task) throw new Error("Missing task");
  const wire = toSnapshot(h.fixture);
  act(() => {
    h.store.applyProtocol(
      stateFromSnapshot(wire.meta, {
        ...wire.body,
        pullRequests: [],
        pullRequestDetails: [],
        inbox: [
          {
            taskId: task.id,
            reasonRuns: {},
            reviewedHead: null,
            planVersion: null,
            workTime: { startedAt: null, readyAt: null },
            linkedPrNumbers: [42, 43],
          },
        ],
      }),
    );
    h.root.render(
      createElement(StoreProvider, {
        store: h.store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: createElement(Detail, { task: { ...task, prNumber: 42 } }),
      }),
    );
  });
  expect(
    [...h.host.querySelectorAll("button")].filter(
      (b) => b.textContent === "PR #42",
    ),
  ).toHaveLength(1);
  act(() => h.button("PR #43").click());
  expect(h.store.getState().ui.openPr).toEqual({
    repoId: task.repoId,
    number: 43,
  });
});

test("a branch before its PR reads the coordinator diff", async () => {
  const h = setup();
  const task = h.fixture.tasks.find((task) => task.branch);
  if (!task) throw new Error("Missing branch");
  const branchTask = { ...task, prNumber: null };
  act(() => {
    h.store.getState().snapshot.pullRequests = [];
    h.store.getState().inbox = [];
    h.store.open(task.id);
    h.root.render(
      createElement(StoreProvider, {
        store: h.store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: createElement(Detail, { task: branchTask }),
      }),
    );
  });
  h.sender.mockResolvedValue({
    ok: true,
    result: {
      kind: "diff",
      diff: {
        taskId: task.id,
        range: {
          baseSha: h.row.detail.baseSha,
          headSha: h.row.detail.headSha,
          mode: "whole_branch",
        } as never,
        patch: { text: h.row.patch?.patch ?? "", key: "branch-fixture" },
        files: [],
        computedAt: h.row.detail.observedAt,
      },
    },
  });
  await act(async () => {
    await import("./branch-diff.js");
  });
  await h.click("Diff");
  expect(h.sender).toHaveBeenCalledWith({
    kind: "fetch_diff",
    taskId: task.id,
    range: { mode: "whole_branch" },
  });
  expect(h.host.querySelector('[data-testid="pierre"]')).not.toBeNull();
});
