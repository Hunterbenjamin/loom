import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookLog, HookReceipt } from "@loom/adapter-claude";
import type { IsoTime, ProviderSessionId } from "@loom/core";
import { expect, it } from "vitest";
import { config, now } from "../test/fixtures.js";
import { openStore } from "./index.js";

it("implements HookLog, preserves order and extra payload fields, and prunes only receipts older than seven days", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-hooks-"));
  const sessionId = "fixture-session" as ProviderSessionId;
  let store = await openStore({ dataRoot: root, instance: "dev", config, now });
  try {
    const log: HookLog = store.hooks;
    const receipt: Omit<HookReceipt, "seq"> = {
      sessionId,
      event: "UserPromptSubmit",
      promptId: "prompt-1",
      receivedAt: now,
      payload: {
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt_id: "prompt-1",
        prompt: "Fixture prompt",
        future_field: { preserved: true },
      },
    };
    const old = await log.append({
      ...receipt,
      receivedAt: "2026-09-04T23:59:59.999Z" as IsoTime,
    });
    const boundary = await log.append({
      ...receipt,
      receivedAt: "2026-09-05T00:00:00.000Z" as IsoTime,
    });
    const current = await log.append(receipt);
    expect([old.seq, boundary.seq, current.seq]).toEqual([1, 2, 3]);
    expect(await log.bySession(sessionId)).toEqual([old, boundary, current]);
    expect(await log.bySession("unrelated" as ProviderSessionId)).toEqual([]);
    store.close();
    store = await openStore({ dataRoot: root, instance: "dev", config, now });
    expect(await store.hooks.bySession(sessionId)).toEqual([boundary, current]);
    expect(store.hooks.prune(now)).toBe(0);
    expect((await store.hooks.append(receipt)).seq).toBe(4);
    await expect(
      store.hooks.append({
        ...receipt,
        sessionId: "wrong" as ProviderSessionId,
      }),
    ).rejects.toThrow("identity");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
