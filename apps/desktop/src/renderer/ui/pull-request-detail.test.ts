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
    return createElement("div", { "data-testid": "pierre" });
  },
}));
const viewer = vi.fn();
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  viewer.mockClear();
});
function setup(change: Partial<PullRequestDetailRow["detail"]> = {}) {
  const fixture = buildSnapshot();
  const row = buildPullRequestDetails(fixture.pullRequests)[0];
  if (!row) throw new Error("Missing fixture");
  row.detail = { ...row.detail, ...change };
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
  [{ state: "closed" }, "The pull request is not open."],
  [{ state: "merged" }, "The pull request is not open."],
] as const)(
  "merge remains visible and explains refusal %j",
  (change, reason) => {
    const h = setup(change);
    expect(h.button("Squash and merge").disabled).toBe(true);
    expect(h.host.textContent).toContain(reason);
    expect(h.sender).not.toHaveBeenCalled();
  },
);

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
    expect(h.button("Squash and merge").disabled).toBe(false);
    expect(h.button("Delete branch").disabled).toBe(true);
    await h.click("Squash and merge");
    const dialog = h.host.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain(h.row.detail.headSha);
    expect(dialog?.textContent).toContain(h.row.detail.base);
    expect(
      dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')
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
    expect(h.host.textContent).toContain(`Merged at ${h.row.detail.mergedAt}`);
    expect(h.host.textContent).toContain("Branch deleted.");
    expect(h.button("Delete branch").disabled).toBe(true);
  },
);

test("cancel sends nothing; unchecking deletion reaches the command and GitHub errors stay inline", async () => {
  const h = setup();
  await h.click("Squash and merge");
  await h.click("Cancel");
  expect(h.sender).not.toHaveBeenCalled();
  await h.click("Squash and merge");
  act(() =>
    h.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
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
  await h.click("Squash and merge");
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
  for (const label of ["Squash and merge", "Delete branch", "Close", "Refresh"])
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
  await h.click("Checks");
  expect(h.host.textContent).toContain("completed · success");
  expect(h.host.textContent).toContain("2m 0s");
  expect(h.host.querySelector(".pr-data a")?.getAttribute("href")).toBe(
    h.row.detail.checkRuns[0]?.url,
  );
  await h.click("Commits");
  expect(h.host.querySelector(".pr-commit")?.textContent).toContain(
    h.row.detail.headSha.slice(0, 7),
  );
  await act(async () => {
    await import("./diff.js");
  });
  await h.click("Files");
  expect(h.host.textContent).toContain("Read-only");
  const first = viewer.mock.lastCall?.[0] as {
    items: { version: number; fileDiff: unknown }[];
    options: { enableLineSelection: boolean };
    renderAnnotation?: unknown;
  };
  expect(first.options.enableLineSelection).toBe(false);
  expect(first.renderAnnotation).toBeUndefined();
  expect(first.items).toHaveLength(1);
  act(() => {
    h.row.patch.patch = h.row.patch.patch.replace(`= ${h.row.number}`, "= 999");
    h.update();
  });
  const second = viewer.mock.lastCall?.[0] as typeof first;
  expect(second.items[0]?.version).not.toBe(first.items[0]?.version);
  act(() => {
    h.row.patch.truncated = true;
    h.update();
  });
  expect(h.host.textContent).toContain("truncated");
  expect(h.host.textContent).toContain("No complete file diff");
  act(() => {
    h.row.patch.truncated = false;
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
