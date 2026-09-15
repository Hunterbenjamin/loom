import {
  findingAnchor,
  message,
  run,
  repo as wireRepo,
  task as wireTask,
} from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { now, repo, required, richState, task } from "../test/fixtures.js";
import {
  anchorSchema,
  approvalSchema,
  contextSchema,
  locationSchema,
  messageSchema,
  repoSchema,
  runSchema,
  taskSchema,
} from "./entity-schemas.js";

describe("shared entity boundary compatibility", () => {
  it("keeps legacy task defaults, scalar limits and nested unknown-key stripping", () => {
    const row = {
      ...task(),
      id: "legacy\tid",
      summary: undefined,
      size: undefined,
      budgetMinutes: 0.5,
      worktreePath: "relative/",
      branch: "",
      retiredField: true,
      providers: { ...task().providers, retiredRole: "codex" },
      attention: {
        reasons: ["question"],
        reasonSince: {},
        since: null,
        retired: true,
      },
    };
    const parsed = taskSchema.parse(row);
    expect(parsed).toMatchObject({
      id: row.id,
      summary: null,
      size: "normal",
      budgetMinutes: 0.5,
    });
    expect(parsed).not.toHaveProperty("retiredField");
    expect(parsed.providers).not.toHaveProperty("retiredRole");
    expect(parsed.attention).not.toHaveProperty("retired");
    expect(wireTask.safeParse(row).success).toBe(false);
    expect(taskSchema.safeParse({ ...task(), budgetMinutes: 0 }).success).toBe(
      true,
    );
    expect(taskSchema.safeParse({ ...task(), reviewRoundCap: 0 }).success).toBe(
      false,
    );
    expect(wireTask.safeParse({ ...task(), reviewRoundCap: 0 }).success).toBe(
      true,
    );
  });

  it("keeps loose stored repository strings and strict wire identities", () => {
    const row = {
      ...repo,
      id: "r".repeat(513),
      root: "",
      github: "legacy",
      retired: true,
    };
    expect(repoSchema.parse(row)).toEqual({
      id: row.id,
      root: "",
      github: "legacy",
    });
    expect(wireRepo.safeParse(row).success).toBe(false);
  });

  it("strips old nested run fields without requiring canonical paths or nonempty panes", () => {
    const row = {
      ...required(richState().runs[0]),
      worktreePath: "",
      sessionId: "legacy\nid",
      pane: {
        hostGeneration: "",
        sessionName: "",
        windowId: "",
        paneId: "",
        retired: true,
      },
      tokenUsage: [
        {
          sessionId: "legacy\nid",
          counts: {
            input: 1,
            cachedInput: 0,
            output: 0,
            reasoning: 0,
            retired: true,
          },
          observedAt: now,
          retired: true,
        },
      ],
    };
    const parsed = runSchema.parse(row);
    expect(parsed.pane).not.toHaveProperty("retired");
    expect(parsed.tokenUsage?.[0]?.counts).not.toHaveProperty("retired");
    expect(run.safeParse(row).success).toBe(false);
  });

  it("retains stored hash checks and the existing omission of derived delivery reasons", () => {
    const original = required(richState().messages[0]);
    const row = {
      ...original,
      deliveryReason: "waiting",
      transportRef: "",
      expectedTurnId: "",
      baselineTurnId: "",
      delivered: {
        via: "claude_user_prompt_submit",
        promptId: "",
        at: now,
        retired: true,
      },
    };
    const parsed = messageSchema.parse(row);
    expect(parsed).not.toHaveProperty("deliveryReason");
    expect(parsed.delivered).not.toHaveProperty("retired");
    expect(
      messageSchema.safeParse({ ...original, textHash: "short" }).success,
    ).toBe(false);
    expect(
      message.safeParse({
        ...original,
        textHash: "short",
        deliveryReason: "waiting",
      }).success,
    ).toBe(true);
  });

  it("keeps anchor paths tolerant, hashes strict, and stored location versions positive", () => {
    const anchor = {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      oldPath: "",
      newPath: "../legacy",
      oldBlobOid: null,
      newBlobOid: null,
      side: "new",
      startLine: 1,
      endLine: 1,
      startColumn: null,
      endColumn: null,
      selectedText: "",
      selectedTextHash: "c".repeat(64),
      contextBeforeHash: "d".repeat(64),
      contextAfterHash: "e".repeat(64),
      normalization: "lf-v1",
      retired: true,
    };
    expect(anchorSchema.parse(anchor)).not.toHaveProperty("retired");
    expect(findingAnchor.safeParse(anchor).success).toBe(false);
    expect(
      anchorSchema.safeParse({ ...anchor, selectedTextHash: "short" }).success,
    ).toBe(false);
    const location = {
      headSha: anchor.headSha,
      path: "",
      blobOid: null,
      side: "new",
      startLine: null,
      endLine: null,
      status: "exact",
      version: 1,
      mappedAt: now,
    };
    expect(locationSchema.safeParse(location).success).toBe(true);
    expect(locationSchema.safeParse({ ...location, version: 0 }).success).toBe(
      false,
    );
  });

  it("retains positive approval versions and tolerant stored context parts", () => {
    const state = richState();
    const approval = required(state.approvals[0]);
    expect(approvalSchema.parse({ ...approval, retired: true })).toEqual(
      approval,
    );
    expect(
      approvalSchema.safeParse({ ...approval, planVersion: 0 }).success,
    ).toBe(false);
    const parsed = contextSchema.parse({
      ...state,
      ciGate: {
        headSha: "a".repeat(40),
        since: now,
        retired: true,
        ci: {
          conclusion: "success",
          observedAt: now,
          checks: [
            {
              name: "",
              status: "completed",
              conclusion: null,
              url: "legacy-url",
              retired: true,
            },
          ],
        },
      },
    });
    expect(parsed.ciGate).not.toHaveProperty("retired");
    expect(parsed.ciGate?.ci?.checks[0]).toEqual({
      name: "",
      status: "completed",
      conclusion: null,
      url: "legacy-url",
    });
  });
});
