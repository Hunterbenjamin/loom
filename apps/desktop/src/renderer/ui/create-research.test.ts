// @vitest-environment happy-dom
import type { AckOutcome, Command, ResearchEntry } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { CreateDialog } from "./creatables.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() =>
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  }),
);
function setup() {
  const store = createFixtureStore(buildSnapshot());
  store.setCreate("research");
  const send = vi
    .fn<(command: Command) => Promise<AckOutcome>>()
    .mockImplementation(async (command) => {
      if (command.kind !== "start_research")
        throw new Error("Unexpected command");
      const entry: ResearchEntry = {
        id: command.id,
        question: command.question,
        directory: command.directory,
        origin: "agent",
        status: "running",
        provider: "codex",
        model: "test",
        sessionId: null,
        pane: null,
        observedStatus: "working",
        startedAt: "2026-09-16T00:00:00Z",
        finishedAt: null,
        archivedAt: null,
        error: null,
        document: null,
      };
      return { ok: true, result: { kind: "research_entry", entry } };
    });
  store.setSender(send);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider requires children.
        children: createElement(CreateDialog),
      }),
    ),
  );
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  const get = <T extends Element>(selector: string) =>
    host.querySelector<T>(selector)!;
  const change = (selector: string, value: string) =>
    act(() => {
      const element = get<HTMLInputElement | HTMLTextAreaElement>(selector);
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const submit = () =>
    act(async () => {
      get("form").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    )!;
  return { store, send, host, get, change, submit, button };
}

test("requires both fields and defaults Directory to the selected repository", async () => {
  const h = setup();
  const state = h.store.getState();
  expect(h.get<HTMLInputElement>("#research-directory").value).toBe(
    state.snapshot.repos.find((repo) => repo.id === state.ui.repo)?.root,
  );
  expect(h.button("Create research").disabled).toBe(true);
  h.change("#research-question", "Question");
  expect(h.button("Create research").disabled).toBe(false);
  h.change("#research-directory", "  ");
  expect(h.button("Create research").disabled).toBe(true);
  await h.submit();
  expect(h.send).not.toHaveBeenCalled();
});

test("Cmd+Enter sends a fresh UUID and opens the acknowledged entry in Research", async () => {
  const h = setup();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    act(() => h.store.setCreate("research"));
    h.change("#research-directory", "/tmp/research");
    h.change("#research-question", "How does it work?");
    await act(async () => {
      h.get("textarea").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const command = h.send.mock.lastCall![0];
    expect(command).toEqual({
      kind: "start_research",
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      directory: "/tmp/research",
      question: "How does it work?",
    });
    if (command.kind !== "start_research")
      throw new Error("Unexpected command");
    ids.push(command.id);
    expect(h.store.getState().ui).toMatchObject({
      create: null,
      view: "research",
      openResearch: command.id,
    });
    expect(h.host.querySelector("dialog")).toBeNull();
  }
  expect(ids[0]).not.toBe(ids[1]);
});

test("a concurrent-research refusal stays inline and preserves the editable draft", async () => {
  const h = setup();
  h.send.mockResolvedValue({
    ok: false,
    error: {
      code: "guard_failed",
      message: "Another research is already running",
      details: [],
    },
  });
  h.change("#research-directory", "/tmp/read");
  h.change("#research-question", "Keep my question");
  await h.submit();
  expect(h.get('[role="alert"]').textContent).toBe(
    "Another research is already running",
  );
  expect(h.get<HTMLInputElement>("#research-directory").value).toBe(
    "/tmp/read",
  );
  expect(h.get<HTMLTextAreaElement>("textarea").value).toBe("Keep my question");
  expect(h.button("Create research").disabled).toBe(false);
  expect(h.store.getState().ui.create).toBe("research");
});

test("edited drafts require confirmation; Keep editing and Escape preserve them", () => {
  const h = setup();
  h.change("#research-question", "Keep this");
  act(() => h.button("Cancel").click());
  expect(document.activeElement).toBe(h.button("Keep editing"));
  act(() =>
    h.get("dialog").dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(h.get<HTMLTextAreaElement>("textarea").value).toBe("Keep this");
  act(() => h.button("Cancel").click());
  act(() => h.button("Discard draft").click());
  expect(h.host.querySelector("dialog")).toBeNull();
  expect(h.send).not.toHaveBeenCalled();
});

test("pending submission prevents duplicate commands and dismissal", async () => {
  const h = setup();
  let resolve!: (outcome: AckOutcome) => void;
  h.send.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  h.change("#research-question", "Wait for the acknowledgement");
  await h.submit();
  await h.submit();
  act(() =>
    h.get("dialog").dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.get<HTMLFieldSetElement>("fieldset").disabled).toBe(true);
  expect(h.store.getState().ui.create).toBe("research");
  await act(async () =>
    resolve({
      ok: false,
      error: { code: "guard_failed", message: "Refused", details: [] },
    }),
  );
});
