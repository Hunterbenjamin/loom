import type { BriefRunSummary } from "@loom/protocol";

export const statusLabels: Record<BriefRunSummary["status"], string> = {
  running: "Researching",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};
export function ResearchGlyph({
  status,
}: {
  status: BriefRunSummary["status"];
}) {
  const [symbol, tone] =
    status === "completed"
      ? ["✓", "good"]
      : status === "running"
        ? ["●", "attention"]
        : status === "failed"
          ? ["×", "danger"]
          : ["◌", ""];
  return (
    <span
      className={`review-status ${tone}`}
      role="img"
      aria-label={statusLabels[status]}
      title={statusLabels[status]}
    >
      {symbol}
    </span>
  );
}
