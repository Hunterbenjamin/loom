import { describe, expect, it } from "vitest";
import { command, finding, fixture, now } from "../test/fixtures.js";
import { reconcile } from "./engine.js";
import { structurallyEqual } from "./helpers.js";

function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    ) as T;
  return value;
}

describe("structural no-op detection", () => {
  it("compares nested records independently of key insertion order", () => {
    expect(
      structurallyEqual(
        { a: 1, nested: { x: "x", y: [null, false] } },
        { nested: { y: [null, false], x: "x" }, a: 1 },
      ),
    ).toBe(true);
  });

  it.each([
    [
      [1, 2],
      [2, 1],
    ],
    [{ a: 1 }, { a: 2 }],
    [{ a: undefined }, {}],
    [{ a: null }, { a: undefined }],
    [[], {}],
    [() => 1, () => 1],
  ])("distinguishes unequal values without JSON coercion", (a, b) => {
    expect(structurallyEqual(a, b)).toBe(false);
  });

  it("short-circuits references and the first difference", () => {
    let reads = 0;
    const unread = {
      get later() {
        reads++;
        return 1;
      },
    };
    expect(structurallyEqual(unread, unread)).toBe(true);
    expect(structurallyEqual({ first: 1, unread }, { first: 2, unread })).toBe(
      false,
    );
    expect(reads).toBe(0);
  });

  it("does not bump task or artifact versions when loaded object keys are reordered", () => {
    const f = fixture();
    f.state.findings = [finding()];
    const settled = reconcile(f.state, f.observations).next;
    const reordered = reverseKeys(settled);
    const result = reconcile(reordered, f.observations);
    expect(result.next.task.version).toBe(settled.task.version);
    expect(result.next.artifacts).toEqual(settled.artifacts);
    expect(result.actions).toEqual([]);
    expect(result.transitions).toEqual([]);
  });

  it("does not rewrite an equal findings projection with reordered keys", () => {
    const f = fixture();
    f.state.findings = [finding()];
    const settled = reconcile(f.state, f.observations).next;
    settled.artifactContents.findings = reverseKeys(
      settled.artifactContents.findings,
    );
    expect(reconcile(settled, f.observations).next.task.version).toBe(
      settled.task.version,
    );
  });

  it("a real finding change still updates the projection and task version once", () => {
    const f = fixture("in_review");
    f.state.findings = [finding()];
    const settled = reconcile(f.state, f.observations).next;
    f.observations.inputs = [
      command({
        type: "waive_finding",
        findingId: finding().id,
        note: "Accepted",
      }),
    ];
    const result = reconcile(reverseKeys(settled), f.observations);
    expect(result.next.task.version).toBe(settled.task.version + 1);
    expect(result.next.artifactContents.findings).toMatchObject([
      { status: "waived" },
    ]);
    expect(
      result.next.artifacts.find((a) => a.kind === "findings")?.version,
    ).toBe(2);
    expect(result.next.task.updatedAt).toBe(now);
    expect(reconcile(result.next, f.observations).next.task.version).toBe(
      result.next.task.version,
    );
  });
});
