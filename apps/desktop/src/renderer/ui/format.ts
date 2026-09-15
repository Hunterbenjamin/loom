import type {
  AttentionReason,
  IsoTime,
  RunStatus,
  Stage,
  TokenCounts,
} from "@loom/core";
import { STAGE_VALUES } from "@loom/core";

export const STAGES: Stage[] = [...STAGE_VALUES];

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: "Backlog",
  todo: "Todo",
  planning: "Planning",
  plan_approval: "Plan approval",
  in_progress: "In progress",
  ci: "CI",
  in_review: "In review",
  awaiting_approval: "Awaiting approval",
  merging: "Merging",
  done: "Done",
  canceled: "Canceled",
};

export function age(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** A span of work: "45m", "1h 20m", "2d 3h". */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function since(now: IsoTime, at: IsoTime): string {
  return age(Math.round((Date.parse(now) - Date.parse(at)) / 60_000));
}

export function clock(at: IsoTime): string {
  const date = new Date(at);
  return `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)}`;
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatTokenCount(value: number): string {
  return compactNumber.format(value);
}

export function formatTokenUsage(counts: TokenCounts): string {
  return `${formatTokenCount(counts.input)} in · ${formatTokenCount(counts.cachedInput)} cached · ${formatTokenCount(counts.output)} out · ${formatTokenCount(counts.reasoning)} reasoning`;
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
  idle_without_submission: "Stopped without submitting",
  status_unknown: "Status unknown",
  observability_failure: "Observability failure",
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

/** Stable model family for compact labels; retain unfamiliar model names as a fallback. */
export function shortModelName(model: string): string {
  const family = model.match(
    /(?:^|[-_\s])(haiku|sonnet|opus|astra|sol|terra|luna|spark)(?=$|[-_\s])/i,
  )?.[1];
  if (family) return family.toLowerCase();
  if (/(?:^|[-_\s])codex(?=$|[-_\s])/i.test(model)) return "codex";
  return model.trim() || "—";
}
