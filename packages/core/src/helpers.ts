import type { Finding, MessagePurpose, Role, Stage } from "./entities.js";
import type { IsoTime, MessageId, RunId, TaskId } from "./ids.js";
import type { Reading } from "./observations.js";

export const read = <T>(
  reading: Reading<T> | null | undefined,
): T | undefined => (reading?.ok ? reading.value : undefined);
export const millis = (time: IsoTime): number => Date.parse(time);
export const later = (time: IsoTime, ms: number): IsoTime =>
  new Date(millis(time) + ms).toISOString() as IsoTime;
export const runId = (task: TaskId, role: Role, round: number): RunId =>
  `${task}/${role}/${round}` as RunId;
export const messageId = (
  run: RunId,
  purpose: MessagePurpose,
  sequence: string | number,
): MessageId => `${run}/${purpose}/${sequence}` as MessageId;
export const normalizeText = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\t/g, "    ");
export const openBlocking = (findings: Finding[]): number =>
  findings.filter(
    (f) =>
      f.blocking &&
      f.status !== "resolved" &&
      f.status !== "waived" &&
      f.status !== "fixed",
  ).length;
export const roleOwesWork = (
  stage: Stage,
  role: Role,
  blocked: boolean,
  failed: boolean,
  /** The implementer submitted and Loom waits on CI (ci-gate.ts): it owes nothing yet. */
  waitingForCi = false,
): boolean =>
  !blocked &&
  !failed &&
  ((stage === "planning" && role === "planner") ||
    (stage === "in_progress" && role === "implementer" && !waitingForCi) ||
    (stage === "in_review" && role === "reviewer"));
export const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clone(v)]),
    ) as T;
  return value;
};

/** Equality for core's acyclic plain records/arrays; object key order is immaterial.
 * Short-circuits identical references and the first difference, without serializing state.
 * Arrays remain ordered. Functions (in config) compare by identity.
 */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]),
    )
  );
}
