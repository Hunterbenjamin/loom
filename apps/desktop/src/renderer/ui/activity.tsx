import type { IsoTime } from "@loom/core";
import { useStore } from "../store/react.js";
import { since } from "./format.js";
import { PullRequestGlyph } from "./pull-request-glyph.js";
import { PrMarkdown } from "./pull-request-overview.js";

/** One line of an Overview's activity, from the issue (Loom) or its pull request (GitHub). */
export interface ActivityItem {
  id: string;
  at: string | null;
  label: string;
  url: string | null;
  body: string;
  kind:
    | "opened"
    | "commit"
    | "review"
    | "comment"
    | "merged"
    | "stage"
    | "flag"
    | "run"
    | "message"
    | "note";
}

const GLYPHS: Partial<Record<ActivityItem["kind"], string>> = {
  commit: "◇",
  stage: "→",
  flag: "!",
  run: "▸",
};

/** Oldest first, in the pull request activity style. */
export function ActivityList({ items }: { items: ActivityItem[] }) {
  const now = useStore((s) => s.snapshot.now);
  const sorted = [...items].sort((a, b) =>
    (a.at ?? "9999").localeCompare(b.at ?? "9999"),
  );
  return (
    <section className="pr-activity">
      <h3>Activity</h3>
      {sorted.length ? null : <p className="faint">No activity yet.</p>}
      <ol>
        {sorted.map((item) => (
          <li
            key={item.id}
            className={item.kind === "commit" ? "pr-commit" : undefined}
            data-activity={item.kind}
          >
            {item.kind === "opened" || item.kind === "merged" ? (
              <PullRequestGlyph
                state={item.kind === "merged" ? "merged" : "open"}
              />
            ) : (
              <span className="pr-activity-dot" aria-hidden="true">
                {GLYPHS[item.kind] ?? "○"}
              </span>
            )}
            <div>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.label}
                </a>
              ) : (
                <span>{item.label}</span>
              )}
              <span className="faint">
                {" "}
                ·{" "}
                {item.at ? (
                  <time dateTime={item.at} title={item.at}>
                    {since(now, item.at as IsoTime)} ago
                  </time>
                ) : (
                  "Time unavailable"
                )}
              </span>
              {item.body ? <PrMarkdown body={item.body} /> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
