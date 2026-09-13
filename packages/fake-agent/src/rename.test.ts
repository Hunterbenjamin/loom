import type { TaskId, WorktreePath } from "@loom/core";
import { expect, test } from "vitest";
import { FakePaneHost } from "./owners.js";

test("fake rename preserves workspace, scratch and pane identity", async () => {
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
  const rename = {
    hostGeneration: ref.hostGeneration,
    sessionId: before?.sessionId as string,
    name: "New space",
  };
  await host.renameSession(rename);
  await host.renameSession(rename);
  await host.renameWindow({
    hostGeneration: ref.hostGeneration,
    windowId: ref.windowId as string,
    name: "New tab",
  });
  expect(await host.getPane(ref)).toMatchObject({
    windowName: "New tab",
    workspaceId: workspace.workspaceId,
    ref: { ...ref, sessionName: "New space" },
  });
  expect((await host.getPane(sibling))?.ref.sessionName).toBe("New space");
  expect(await host.createScratch(request)).toMatchObject({
    ...ref,
    sessionName: "New space",
  });
  expect(await host.listPanes()).toHaveLength(2);
  expect(
    await host.createScratch({ ...request, key: crypto.randomUUID() }),
  ).toMatchObject({ sessionName: "New space" });
  await expect(
    host.renameSession({ ...rename, hostGeneration: "stale" }),
  ).rejects.toThrow();
  await expect(
    host.renameWindow({
      hostGeneration: "stale",
      windowId: ref.windowId as string,
      name: "Wrong",
    }),
  ).rejects.toThrow();
});
