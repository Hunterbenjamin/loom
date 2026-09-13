import type { PullRequestRow } from "@loom/protocol";

export function PullRequestGlyph({
  state,
}: {
  state: PullRequestRow["state"];
}) {
  return (
    <svg
      className={`pr-glyph pr-${state}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      role="img"
      aria-label={
        state === "open"
          ? "Open pull request"
          : state === "merged"
            ? "Merged pull request"
            : "Closed pull request"
      }
    >
      <circle cx="4" cy="3" r="2" />
      <circle cx="12" cy="13" r="2" />
      <path d="M4 5v10" />
      {state === "merged" ? (
        <path d="M4 5c0 5 8 1 8 6" />
      ) : state === "closed" ? (
        <path d="m10 2 4 4m0-4-4 4M12 8v3" />
      ) : (
        <path d="M9 2h1a2 2 0 0 1 2 2v7" />
      )}
    </svg>
  );
}
