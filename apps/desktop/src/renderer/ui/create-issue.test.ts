// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskId } from "@loom/core";
import { type AckOutcome, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { StoreProvider } from "../store/react.js";
import { cursorRows } from "../store/selectors.js";
import { createStore } from "../store/store.js";
import { CreateIssue } from "./create-issue.js";
import { useShortcuts } from "./keys.js";
import { Palette } from "./palette.js";
import { Sidebar } from "./sidebar.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.restoreAllMocks();
});
const id = "LOOM-9999" as TaskId;
const created: AckOutcome = {
  ok: true,
  result: { kind: "task_created", taskId: id },
};
const moved: AckOutcome = {
  ok: true,
  result: { kind: "human", inputId: "input-created" as never },
};
const rejected: AckOutcome = {
  ok: false,
  error: {
    code: "guard_failed",
    message: "Cannot start",
    details: ["Repository unavailable"],
  },
};

function setup({ open = true, repo = "repo-loom", emptyRepos = false } = {}) {
  let snapshot = buildSnapshot();
  if (emptyRepos) snapshot.repos = [];
  const store = createStore(snapshot, "dev");
  if (!emptyRepos) {
    const { body, meta } = toSnapshot(snapshot);
    body.projects = [
      {
        id: "project",
        repoId: snapshot.repos.find((r) => r.id === repo)?.id ?? null,
      },
    ];
    store.applyProtocol(stateFromSnapshot(meta, body));
  }
  snapshot = store.getState().snapshot;
  store.setCreateIssue(open);
  const send = vi
    .fn<(command: unknown) => Promise<AckOutcome>>()
    .mockResolvedValue(created);
  store.setSender(send);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  function Keyboard() {
    useShortcuts(store);
    return null;
  }
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider requires children.
        children: [
          createElement(Keyboard, { key: "keys" }),
          createElement(Sidebar, { key: "sidebar" }),
          createElement(Palette, { key: "palette" }),
          createElement(CreateIssue, { key: "create" }),
        ],
      }),
    ),
  );
  function get<T extends Element>(selector: string) {
    const element = host.querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }
  function change(selector: string, value: string) {
    const element = get<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(selector);
    // Use the native setter so React sees a user change rather than its value tracker.
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
        element,
        value,
      );
      element.dispatchEvent(
        new Event(element instanceof HTMLSelectElement ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  }
  async function submit() {
    await act(async () =>
      get<HTMLFormElement>("dialog form").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  }
  function button(text: string) {
    const element = [
      ...host.querySelectorAll<HTMLButtonElement>("dialog button"),
    ].find((b) => b.textContent === text);
    if (!element) throw new Error(`Missing button ${text}`);
    return element;
  }
  function cancelDialog() {
    act(() =>
      get<HTMLDialogElement>("dialog").dispatchEvent(
        new Event("cancel", { cancelable: true }),
      ),
    );
  }
  return {
    store,
    snapshot,
    send,
    host,
    get,
    change,
    submit,
    button,
    cancelDialog,
  };
}

test("validates a required trimmed title and repository before sending", async () => {
  const h = setup();
  expect(document.activeElement).toBe(h.get("#issue-title"));
  expect(h.button("Create issue").disabled).toBe(true);
  h.change("#issue-title", "   ");
  await h.submit();
  expect(h.send).not.toHaveBeenCalled();
  h.change("#issue-title", "A title");
  expect(h.button("Create issue").disabled).toBe(false);
  h.change("#issue-title", "x".repeat(201));
  await h.submit();
  expect(h.send).not.toHaveBeenCalled();
  h.change("#issue-title", "A title");
  h.change("#issue-description", "x".repeat(20001));
  await h.submit();
  expect(h.send).not.toHaveBeenCalled();
});

test("suggests a short name until the human edits it", () => {
  const h = setup();
  h.change(
    "#issue-title",
    "Floating chat window for Main and every active implementation run",
  );
  expect(h.get<HTMLInputElement>("#issue-name").value).toBe(
    "Floating chat window for Main…",
  );
  h.change("#issue-name", "Chat window");
  h.change("#issue-title", "A completely different title");
  expect(h.get<HTMLInputElement>("#issue-name").value).toBe("Chat window");
});

test("defaults to the sidebar repo and sends the complete backlog payload with markdown intact", async () => {
  const repo = buildSnapshot().repos[1];
  if (!repo) throw new Error("Missing repo");
  const h = setup({ repo: repo.id });
  expect(h.get<HTMLSelectElement>("#issue-repo").value).toBe(repo.id);
  h.change("#issue-title", "  Fix a thing  ");
  h.change("#issue-description", "## Details\n\n- Keep **markdown**\n");
  h.change("#issue-size", "small");
  act(() => h.get<HTMLInputElement>("#issue-plan-approval").click());
  h.store.toggleListSection("backlog");
  h.store.toggleListSection("in_progress");
  h.store.setView("done");
  h.store.setPane("board");
  await h.submit();
  expect(h.send).toHaveBeenCalledExactlyOnceWith({
    kind: "create_task",
    repoId: repo.id,
    title: "Fix a thing",
    name: "Fix a thing",
    description: "## Details\n\n- Keep **markdown**\n",
    summary: null,
    providers: null,
    requirePlanApproval: false,
    blockedBy: [],
    budgetMinutes: null,
    size: "small",
  });
  expect(h.store.getState().snapshot).toBe(h.snapshot);
  expect(h.host.querySelector("dialog")).toBeNull();
  expect(h.store.getState().ui).toMatchObject({
    view: "all",
    pane: "list",
    repo: repo.id,
    toast: `Created ${id}`,
  });
  // The coordinator's patch can arrive after the ack; select its actual sorted position.
  const task = h.snapshot.tasks[0];
  if (!task) throw new Error("Missing task");
  const { meta, body } = toSnapshot({
    ...h.snapshot,
    tasks: [
      ...h.snapshot.tasks,
      { ...task, id, repoId: repo.id, stage: "backlog" },
    ],
  });
  body.projects = [{ id: "project", repoId: repo.id }];
  act(() => h.store.applyProtocol(stateFromSnapshot(meta, body)));
  expect(
    cursorRows(h.store.getState()).at(h.store.getState().ui.cursor ?? -1)?.task
      .id,
  ).toBe(id);
  const newTask = body.tasks.find((task) => task.id === id);
  if (!newTask) throw new Error("Missing new task");
  expect(h.store.getState().ui.listSections.backlog?.collapsed).toBe(false);
  act(() =>
    h.store.applyProtocol(
      stateFromSnapshot(meta, {
        ...body,
        tasks: body.tasks.map((task) =>
          task.id === id ? { ...task, stage: "in_progress" } : task,
        ),
      }),
    ),
  );
  expect(
    cursorRows(h.store.getState()).at(h.store.getState().ui.cursor ?? -1)?.task
      .id,
  ).toBe(id);
});

test("Todo waits for task_created before moving and prevents duplicate submissions", async () => {
  const h = setup();
  expect(h.get<HTMLSelectElement>("#issue-repo").value).toBe(
    h.snapshot.repos[0]?.id,
  );
  let resolve: (outcome: AckOutcome) => void = () => {};
  h.send
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValue(moved);
  h.change("#issue-title", "Start this");
  h.change("#issue-status", "todo");
  await h.submit();
  await h.submit();
  h.cancelDialog();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.host.querySelector("dialog")).not.toBeNull();
  await act(async () => resolve(created));
  expect(h.send).toHaveBeenNthCalledWith(2, {
    kind: "human",
    taskId: id,
    command: { type: "move", to: "todo" },
  });
  expect(h.host.querySelector("dialog")).toBeNull();
  expect(h.store.getState().ui.toast).toBe(
    `Created ${id} · workflow start queued`,
  );
});

test("renders rejected creation inline and keeps the draft", async () => {
  const h = setup();
  h.send.mockResolvedValue(rejected);
  h.change("#issue-title", "Retain this");
  h.change("#issue-status", "todo");
  await h.submit();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.get('[role="alert"]').textContent).toContain(
    "guard_failed: Cannot start\nRepository unavailable",
  );
  expect(h.get<HTMLInputElement>("#issue-title").value).toBe("Retain this");
  expect(h.button("Create issue").disabled).toBe(false);
});

test("retries only the move after creation succeeded but Todo was rejected", async () => {
  const h = setup();
  h.send
    .mockResolvedValueOnce(created)
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(moved);
  h.change("#issue-title", "Only once");
  h.change("#issue-status", "todo");
  await h.submit();
  expect(h.host.textContent).toContain(`${id} was created`);
  expect(h.get<HTMLFieldSetElement>("fieldset").disabled).toBe(true);
  await h.submit();
  expect(h.send.mock.calls.map(([command]) => command)).toEqual([
    expect.objectContaining({ kind: "create_task" }),
    { kind: "human", taskId: id, command: { type: "move", to: "todo" } },
    { kind: "human", taskId: id, command: { type: "move", to: "todo" } },
  ]);
  expect(h.host.querySelector("dialog")).toBeNull();
});

test("Escape cancels empty drafts; edited drafts require discard and keep editing preserves text", () => {
  const h = setup();
  h.cancelDialog();
  expect(h.host.querySelector("dialog")).toBeNull();
  act(() => h.store.setCreateIssue(true));
  h.change("#issue-description", "Do not lose this");
  h.cancelDialog();
  expect(h.host.textContent).toContain("Discard this issue draft?");
  expect(document.activeElement).toBe(h.button("Keep editing"));
  act(() => h.button("Keep editing").click());
  expect(h.get<HTMLTextAreaElement>("#issue-description").value).toBe(
    "Do not lose this",
  );
  act(() => h.button("Cancel").click());
  act(() => h.button("Discard draft").click());
  expect(h.host.querySelector("dialog")).toBeNull();
  expect(h.send).not.toHaveBeenCalled();
});

test("C opens the dialog, ignores typing, and modal shortcuts do not change the underlying Tracker", () => {
  const h = setup({ open: false });
  const typing = document.createElement("input");
  h.host.append(typing);
  act(() =>
    typing.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true }),
    ),
  );
  expect(h.store.getState().ui.createIssue).toBe(false);
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", cancelable: true }),
    ),
  );
  expect(h.store.getState().ui.createIssue).toBe(true);
  expect(h.store.getState().ui.palette).toBe(false);
  act(() => {
    h.store.open(id);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true }),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
  });
  expect(h.store.getState().ui).toMatchObject({
    openTask: id,
    palette: false,
    cursor: null,
  });
});

test("the c key and hinted palette command open the same dialog; C is removed", () => {
  const h = setup({ open: false });
  expect(h.host.querySelector('[aria-label="Create issue"]')).toBeNull();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "C" })));
  expect(h.host.querySelector("dialog")).toBeNull();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" })));
  expect(h.host.querySelector("dialog")).not.toBeNull();
  h.cancelDialog();
  act(() => h.store.setPalette(true));
  const command = [...h.host.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (item) => item.textContent?.startsWith("Create issue…"),
  );
  expect(command?.querySelector("kbd")?.textContent).toBe("c");
  act(() => command?.click());
  expect(h.store.getState().ui).toMatchObject({
    createIssue: true,
    palette: false,
  });
});

test("Cmd+Enter from the markdown description submits", async () => {
  const h = setup();
  h.change("#issue-title", "Keyboard issue");
  await act(async () =>
    h.get("#issue-description").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.host.querySelector("dialog")).toBeNull();
});

test("an empty repository list cannot submit", async () => {
  const h = setup();
  const { meta, body } = toSnapshot({ ...h.snapshot, repos: [] });
  act(() => h.store.applyProtocol(stateFromSnapshot(meta, body)));
  h.change("#issue-title", "No repository");
  expect(h.button("Create issue").disabled).toBe(true);
  await h.submit();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.host.textContent).toContain("No repositories available");
});

test("uses the first repository when the initial snapshot arrives with the dialog already open", () => {
  const h = setup({ emptyRepos: true });
  const snapshot = buildSnapshot();
  const { meta, body } = toSnapshot(snapshot);
  act(() => h.store.applyProtocol(stateFromSnapshot(meta, body)));
  expect(h.get<HTMLSelectElement>("#issue-repo").value).toBe(
    snapshot.repos[0]?.id,
  );
  h.cancelDialog();
  expect(h.host.querySelector("dialog")).toBeNull();
});

test("the project picker has no All option and keeps add/select errors inline", async () => {
  const h = setup({ open: false });
  const picker = h.get<HTMLSelectElement>('[aria-label="Repository"]');
  expect([...picker.options].map((option) => option.textContent)).not.toContain(
    "All repositories",
  );
  expect([...picker.options].map((option) => option.textContent)).toContain(
    "Add repository…",
  );
  const add = vi
    .spyOn(h.store, "addRepo")
    .mockRejectedValue(new Error("No origin remote"));
  await act(async () => h.change('[aria-label="Repository"]', "__add__"));
  expect(add).toHaveBeenCalledTimes(1);
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(
    "No origin remote",
  );
  expect(picker.value).toBe(h.store.getState().ui.repo);
  h.send.mockResolvedValueOnce(rejected);
  await act(async () => h.change('[aria-label="Repository"]', "repo-herdr"));
  expect(h.send).toHaveBeenLastCalledWith({
    kind: "select_repo",
    repoId: "repo-herdr",
  });
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(
    "Cannot start",
  );
  expect(h.store.getState().ui.repo).toBe("repo-loom");
});

test("the project picker clears the shared titlebar inset and remains interactive", () => {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync(join(import.meta.dirname, "../styles/theme.css"), "utf8"),
    readFileSync(join(import.meta.dirname, "../styles/shell.css"), "utf8"),
  ]
    .join("\n")
    .replaceAll("-webkit-app-region", "--test-app-region");
  document.head.append(style);
  try {
    const h = setup({ open: false });
    const top = h.get<HTMLElement>(".sidebar-top");
    const picker = h.get<HTMLSelectElement>('[aria-label="Repository"]');
    expect(getComputedStyle(top).paddingTop).toBe("calc(30px + 8px)");
    expect(getComputedStyle(top).getPropertyValue("--test-app-region")).toBe(
      "drag",
    );
    expect(getComputedStyle(picker).getPropertyValue("--test-app-region")).toBe(
      "no-drag",
    );
  } finally {
    style.remove();
  }
});
