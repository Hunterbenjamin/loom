import type { AttentionReason, IsoTime, RunStatus, Stage } from "@loom/core";
import { STAGE_LABELS } from "../fixtures/index.js";

export { STAGE_LABELS };

export function age(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function since(now: IsoTime, at: IsoTime): string {
  return age(Math.round((Date.parse(now) - Date.parse(at)) / 60_000));
}

export function clock(at: IsoTime): string {
  const date = new Date(at);
  return `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)}`;
}

export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  plan_needs_approval: "Plan needs approval",
  needs_approval: "Needs approval",
  question: "Question",
  provider_permission: "Permission",
  provider_input: "Input",
  blocked: "Blocked",
  failed: "Failed",
  run_vanished: "Run vanished",
  stalled: "Stalled",
  status_unknown: "Status unknown",
  over_budget: "Over budget",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  starting: "Starting",
  working: "Working",
  blocked: "Blocked",
  idle: "Idle",
  failed: "Failed",
  ended: "Ended",
  unknown: "Unknown",
};

export function stageLabel(stage: Stage): string {
  return STAGE_LABELS[stage];
}

export function severityTone(severity: string): string {
  if (severity === "blocker") return "danger";
  if (severity === "major") return "attention";
  if (severity === "nit") return "";
  return "accent";
}
