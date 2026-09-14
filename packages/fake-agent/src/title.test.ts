import type { TaskId, WorktreePath } from "@loom/core";
import { expect, test } from "vitest";
import { FakePaneHost } from "./owners.js";

test("fake titles are scoped, idempotent, clearable, and preserve native identity", async () => {
  const host = new FakePaneHost();
  const cwd = "/tmp/rename" as WorktreePath;
  const workspace = await host.ensureWorkspace({
    taskId: "t-rename" as TaskId,
    cwd,
    label: "Rename",
  });
  const request = {
    workspaceId: workspace.workspaceId,
    key: crypto.randomUUID(),
    cwd,
    executable: "sh",
    args: [],
    env: {},
  };
  const ref = await host.createScratch(request);
  const sibling = await host.createScratch({
    ...request,
    key: crypto.randomUUID(),
  });
  const before = await host.getPane(ref);
  const setSpace = {
    hostGeneration: ref.hostGeneration,
    target: { kind: "space" as const, sessionId: before?.sessionId as string },
    title: "New space",
  };
  await host.setTitle(setSpace);
  await host.setTitle(setSpace);
  await host.setTitle({
    hostGeneration: ref.hostGeneration,
    target: { kind: "tab", windowId: ref.windowId as string },
    title: "New tab",
  });
  await host.setTitle({
    hostGeneration: ref.hostGeneration,
    target: { kind: "pane", paneId: ref.paneId },
    title: "New pane",
  });
  expect(await host.getPane(ref)).toMatchObject({
    spaceTitle: "New space",
    tabTitle: "New tab",
    paneTitle: "New pane",
    windowName: before?.windowName,
    workspaceId: workspace.workspaceId,
    ref,
  });
  expect(await host.getPane(sibling)).toMatchObject({
    spaceTitle: "New space",
  });
  expect((await host.getPane(sibling))?.tabTitle).toBeUndefined();
  expect((await host.getPane(sibling))?.paneTitle).toBeUndefined();
  await host.setTitle({ ...setSpace, title: " " });
  expect((await host.getPane(ref))?.spaceTitle).toBeNull();
  expect((await host.getPane(ref))?.ref).toEqual(ref);
  expect((await host.getPane(ref))?.windowName).toBe(before?.windowName);
  await expect(
    host.setTitle({ ...setSpace, hostGeneration: "stale" }),
  ).rejects.toThrow();
  await expect(
    host.setTitle({
      hostGeneration: ref.hostGeneration,
      target: { kind: "pane", paneId: "%999" },
      title: "Missing",
    }),
  ).rejects.toThrow();
});
