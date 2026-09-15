import type { Stage, Transition } from "./entities.js";
import type { IsoTime } from "./ids.js";

/** Stages at or past "ready to merge": the work time has stopped. */
const READY: Stage[] = ["awaiting_approval", "merging", "done"];

/**
 * How long an issue's work took: from the first time it entered In progress to the moment it
 * became ready to merge. `readyAt` is the latest entry into Awaiting approval, since conflicts and
 * fix rounds can send it back; an issue merged on GitHub without that stage is ready when it is
 * done. Either is null until it happens, and `readyAt` is null again if the issue left the ready
 * stages without being done.
 */
export function workTime(
  transitions: readonly Pick<Transition, "at" | "from" | "to">[],
  stage: Stage,
): { startedAt: IsoTime | null; readyAt: IsoTime | null } {
  const ordered = [...transitions].sort((a, b) => a.at.localeCompare(b.at));
  const startedAt =
    ordered.find((t) => t.from !== t.to && t.to === "in_progress")?.at ?? null;
  if (!startedAt || !READY.includes(stage)) return { startedAt, readyAt: null };
  const moves = ordered.filter((t) => t.from !== t.to && t.at >= startedAt);
  const ready =
    moves.findLast((t) => t.to === "awaiting_approval") ??
    moves.findLast((t) => t.to === "done");
  return { startedAt, readyAt: ready?.at ?? null };
}
