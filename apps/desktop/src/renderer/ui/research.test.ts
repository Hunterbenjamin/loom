// @vitest-environment happy-dom
import type {
  AckOutcome,
  Command,
  ResearchComment,
  ResearchEntry,
} from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { ResearchView } from "./research.js";
import { runTrackerAction } from "./tracker-actions.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const saved: ResearchEntry = {
  id: "00000000-0000-4000-8000-000000000001",
  question: "How do keybindings work?",
  directory: null,
  pane: null,
  observedStatus: "unknown",
  origin: "main",
  status: "completed",
  sessionId: null,
  provider: null,
  model: null,
  startedAt: "2026-09-16T00:00:00.000Z",
  finishedAt: "2026-09-16T00:00:00.000Z",
  archivedAt: null,
  error: null,
  document: {
    title: "Modes and keybindings",
    body: "## Findings\n\n**Modes** change key meanings.",
    sources: [{ title: "Documentation", url: "https://example.org/keys" }],
  },
};
async function mount(
  entries: ResearchEntry[],
  comments: ResearchComment[] = [],
) {
  const store = createFixtureStore(buildSnapshot());
  const send = vi.fn(async (command: Command): Promise<AckOutcome> => {
    if (
      command.kind === "read_research" ||
      command.kind === "comment_research" ||
      command.kind === "set_research_archived"
    ) {
      const entry = entries.find((entry) => entry.id === command.id);
      if (!entry) throw new Error("Unknown entry");
      if (command.kind === "set_research_archived")
        entry.archivedAt = command.archived ? "2026-09-16T01:00:00.000Z" : null;
      return {
        ok: true,
        result: {
          kind: "research_entry",
          entry: structuredClone(entry),
          comments,
        },
      };
    }
    if (command.kind === "list_research")
      return {
        ok: true,
        result: {
          kind: "research_list",
          state: {
            entries: entries
              .filter((entry) => !!entry.archivedAt === !!command.archived)
              .map(({ document, ...entry }) => ({
                ...entry,
                title: document?.title ?? null,
              })),
            runningId:
              entries.find((entry) => entry.status === "running")?.id ?? null,
          },
        },
      };
    throw new Error(`Unexpected ${command.kind}`);
  });
  store.setSender(send);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: createElement with required typed children.
        children: createElement(ResearchView),
      }),
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { store, host, send };
}
test("lists by month, renders markdown and sources, and archives without losing the open document", async () => {
  const { host, store } = await mount([structuredClone(saved)]);
  expect(host.querySelector("form.list-toolbar")).toBeNull();
  expect(host.querySelector('[aria-label="Research question"]')).toBeNull();
  expect(host.textContent).toContain("September 2026");
  expect(host.textContent).toContain("Saved by Main");
  await act(async () => store.openResearch(saved.id));
  expect(host.querySelector("strong")?.textContent).toBe("Modes");
  expect(
    host.querySelector('a[href="https://example.org/keys"]'),
  ).not.toBeNull();
  expect(host.textContent).toContain("no live-web verification claimed");
  const archive = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Archive",
  );
  await act(async () => archive?.click());
  expect(
    host.querySelector('[data-testid="research-list"]')?.textContent,
  ).not.toContain("Modes and keybindings");
  expect(
    host.querySelector('[data-testid="research-detail"]')?.textContent,
  ).toContain("Modes change key meanings");
  await act(async () => store.openResearch(null));
  await act(async () =>
    (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
  expect(
    host.querySelector('[data-testid="research-list"]')?.textContent,
  ).toContain("Modes and keybindings");
  await act(async () => store.openResearch(saved.id));
  expect(host.textContent).toContain("Unarchive");
});
test("running and interrupted entries stay readable", async () => {
  const entry: ResearchEntry = {
    ...saved,
    origin: "agent",
    provider: "codex",
    model: "gpt-5.6-sol",
    document: null,
    status: "running",
    finishedAt: null,
  };
  const { host, store } = await mount([entry]);
  await act(async () => store.openResearch(entry.id));
  expect(host.textContent).toContain(
    "reading your directory and researching the web",
  );
  expect(
    (
      host.querySelector(
        '[data-testid="research-detail"] form button[type="submit"]',
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  entry.status = "interrupted";
  entry.error = "Coordinator stopped before completion";
  await act(async () => store.openResearch(null));
  await act(async () => store.openResearch(entry.id));
  expect(host.textContent).toContain("interrupted");
  expect(host.textContent).toContain("Coordinator stopped before completion");
});

test("running research renders an ordered thread with the shared keyboard composer enabled", async () => {
  const entry = {
    ...saved,
    origin: "agent" as const,
    status: "running" as const,
    observedStatus: "working" as const,
  };
  const comments: ResearchComment[] = ["human", "main", "agent"].map(
    (author, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 2}`,
      entryId: entry.id,
      author: author as ResearchComment["author"],
      text: `Comment ${index}`,
      at: `2026-09-16T00:00:0${index}.000Z`,
      delivered: true,
    }),
  );
  const { host, store, send } = await mount([entry], comments);
  await act(async () => store.openResearch(entry.id));
  expect(
    [...host.querySelectorAll(".pr-activity li")].map((li) => li.textContent),
  ).toEqual([
    expect.stringContaining("You"),
    expect.stringContaining("Main"),
    expect.stringContaining("Research agent"),
  ]);
  const textarea = host.querySelector(
    ".pr-comment-box textarea",
  ) as HTMLTextAreaElement;
  expect(textarea.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "Please @loom continue");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(send).toHaveBeenCalledWith({
    kind: "comment_research",
    id: entry.id,
    message: "Please @loom continue",
  });
  expect(textarea.value).toBe("");
});

test("reading actions expand the thread and scroll the detail", async () => {
  const comments: ResearchComment[] = Array.from({ length: 5 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 2}`,
    entryId: saved.id,
    author: "human",
    text: `Note ${i}`,
    at: saved.startedAt,
    delivered: true,
  }));
  const { host, store } = await mount([saved], comments);
  await act(async () => store.openResearch(saved.id));
  expect(host.querySelectorAll(".pr-activity li")).toHaveLength(3);
  await act(async () => {
    expect(runTrackerAction(store, "activity")).toBe(true);
  });
  expect(host.querySelectorAll(".pr-activity li")).toHaveLength(5);
  const body = host.querySelector(".pr-page-body") as HTMLElement;
  runTrackerAction(store, "scroll-down");
  expect(body.scrollTop).toBe(60);
});
