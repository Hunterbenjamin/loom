// @vitest-environment happy-dom
import type { AckOutcome, Command, ResearchEntry } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { ResearchView } from "./research.js";

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
async function mount(entries: ResearchEntry[]) {
  const store = createFixtureStore(buildSnapshot());
  const send = vi.fn(async (command: Command): Promise<AckOutcome> => {
    if (
      command.kind === "read_research" ||
      command.kind === "set_research_archived"
    ) {
      const entry = entries.find((entry) => entry.id === command.id);
      if (!entry) throw new Error("Unknown entry");
      if (command.kind === "set_research_archived")
        entry.archivedAt = command.archived ? "2026-09-16T01:00:00.000Z" : null;
      return {
        ok: true,
        result: { kind: "research_entry", entry: structuredClone(entry) },
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
