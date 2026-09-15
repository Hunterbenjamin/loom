import { randomUUID } from "node:crypto";
import { fakeBriefContent } from "@loom/fake-agent";
import { afterEach, expect, test, vi } from "vitest";
import { briefLocalDay, DailyBriefs, researchPrompt } from "./briefs.js";
import { LoomClient } from "./client.js";
import { createHarness } from "./test-support.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const h = await createHarness({ serveProtocol: true });
  cleanups.push(() => h.close());
  let now = "2026-09-14T22:59:59.000Z";
  const research = vi.fn(async () => structuredClone(fakeBriefContent));
  const briefs = new DailyBriefs({
    store: h.store,
    research,
    now: () => now,
    log: () => {},
  });
  cleanups.push(() => briefs.stop());
  return {
    h,
    briefs,
    research,
    setNow: (value: string) => {
      now = value;
    },
  };
}

test("7am Makassar, catch-up, same-day deduplication and next-day scheduling", async () => {
  const { h, briefs, research, setNow } = await setup();
  expect(briefLocalDay("2026-09-14T23:00:00.000Z")).toEqual({
    date: "2026-09-15",
    hour: 7,
  });
  briefs.tick();
  expect(h.store.briefs.list()).toHaveLength(0);
  setNow("2026-09-14T23:00:00.000Z");
  briefs.tick();
  briefs.tick();
  await vi.waitFor(() =>
    expect(h.store.briefs.list()[0]?.status).toBe("completed"),
  );
  expect(research).toHaveBeenCalledTimes(1);
  setNow("2026-09-15T05:00:00.000Z");
  briefs.tick();
  expect(research).toHaveBeenCalledTimes(1);
  setNow("2026-09-16T01:00:00.000Z");
  briefs.tick();
  await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(2));
  expect(h.store.briefs.list()).toHaveLength(2);
});

test("manual refresh works with scheduling disabled and records session before launch", async () => {
  const { h, briefs, research } = await setup();
  h.store.briefs.setEnabled(false);
  research.mockImplementation(async () => {
    expect(
      h.store.briefs.list().find((run) => run.status === "running"),
    ).toMatchObject({
      status: "running",
      sessionId: expect.any(String),
    });
    return structuredClone(fakeBriefContent);
  });
  const id = randomUUID();
  const run = briefs.run("manual", id);
  expect(briefs.run("manual", id).id).toBe(run.id);
  expect(briefs.run("manual").id).toBe(run.id);
  await vi.waitFor(() =>
    expect(h.store.briefs.get(id)?.status).toBe("completed"),
  );
  expect(briefs.run("manual", id).status).toBe("completed");
  expect(research).toHaveBeenCalledTimes(1);
  const second = briefs.run("manual");
  await vi.waitFor(() =>
    expect(h.store.briefs.get(second.id)?.status).toBe("completed"),
  );
  expect(research).toHaveBeenCalledTimes(2);
});

test("failed scheduled research stays visible and is not retried each tick", async () => {
  const { h, briefs, research, setNow } = await setup();
  setNow("2026-09-15T00:00:00.000Z");
  research.mockRejectedValue(new Error("Search unavailable"));
  briefs.tick();
  await vi.waitFor(() =>
    expect(h.store.briefs.list()[0]?.status).toBe("failed"),
  );
  briefs.tick();
  expect(research).toHaveBeenCalledTimes(1);
  expect(h.store.briefs.list()[0]?.error).toBe("Search unavailable");
  research.mockResolvedValue(structuredClone(fakeBriefContent));
  const retry = briefs.run("manual");
  await vi.waitFor(() =>
    expect(h.store.briefs.get(retry.id)?.status).toBe("completed"),
  );
});

test("restart preserves output/schedule and marks abandoned work interrupted", async () => {
  const { h, briefs } = await setup();
  h.store.briefs.setEnabled(false);
  const completed = briefs.run("manual");
  await vi.waitFor(() =>
    expect(h.store.briefs.get(completed.id)?.status).toBe("completed"),
  );
  const abandoned = { ...completed, id: randomUUID(), sessionId: randomUUID() };
  h.store.briefs.put(abandoned);
  await briefs.stop();
  const restarted = await h.restart();
  cleanups.push(() => restarted.close());
  expect(restarted.store.briefs.schedule().enabled).toBe(false);
  expect(restarted.store.briefs.get(completed.id)?.content).toEqual(
    fakeBriefContent,
  );
  expect(restarted.store.briefs.get(abandoned.id)?.status).toBe("interrupted");
});

test("protocol exposes saved history, manual runs and schedule control without creating issues", async () => {
  const { h } = await setup();
  const client = await LoomClient.connect({
    url: h.coordinator.protocol.url as string,
    token: h.config.token,
    clientId: "brief-test",
    kind: "cli",
  });
  cleanups.push(async () => client.close());
  const disabled = await client.command({
    kind: "set_brief_schedule",
    enabled: false,
  });
  expect(disabled).toMatchObject({
    ok: true,
    result: { kind: "briefs", state: { schedule: { enabled: false } } },
  });
  const id = randomUUID();
  const started = await client.command({ kind: "run_brief", id });
  expect(started).toMatchObject({
    ok: true,
    result: { kind: "brief", run: { id } },
  });
  const read = await client.command({ kind: "get_brief", id });
  expect(read).toMatchObject({
    ok: true,
    result: { kind: "brief", run: { id } },
  });
  expect(await client.command({ kind: "get_briefs" })).toMatchObject({
    ok: true,
    result: { state: { runs: [expect.objectContaining({ id })] } },
  });
  expect(h.store.tasks()).toHaveLength(0);
});

test("brief instructions preserve the user's editorial intent and avoid repeating old coverage", () => {
  const prompt = researchPrompt("2026-09-15T00:00:00.000Z", undefined);
  expect(prompt).toContain("plain English");
  expect(prompt).toContain("evidence of demand");
  expect(prompt).toContain("coordination/review costs");
  expect(prompt).toContain("arxiv.org");
});
