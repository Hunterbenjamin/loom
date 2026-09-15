import type { IsoTime } from "@loom/core";
import { useState } from "react";
import { useStore } from "../store/react.js";
import { since } from "./format.js";
import { PullRequestGlyph } from "./pull-request-glyph.js";
import { PrMarkdown } from "./pull-request-overview.js";
import { useTrackerActions } from "./tracker-actions.js";
import { keyHint } from "./tracker-keymap.js";

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

/** How many of the latest entries show before the list is expanded. */
const RECENT = 3;

/**
 * Oldest first, in the pull request activity style. Only the latest entries show until the human
 * expands the earlier ones, as GitHub and Linear do.
 */
export function ActivityList({ items }: { items: ActivityItem[] }) {
  const now = useStore((s) => s.snapshot.now);
  const [expanded, setExpanded] = useState(false);
  useTrackerActions({ activity: () => setExpanded((value) => !value) });
  const all = [...items].sort((a, b) =>
    (a.at ?? "9999").localeCompare(b.at ?? "9999"),
  );
  const hidden = expanded ? 0 : Math.max(0, all.length - RECENT);
  const sorted = all.slice(hidden);
  return (
    <section className="pr-activity">
      <h3>Activity</h3>
      {all.length ? null : <p className="faint">No activity yet.</p>}
      {hidden ? (
        <button
          type="button"
          {...keyHint("activity")}
          className="activity-more"
          onClick={() => setExpanded(true)}
        >
          Show {hidden} earlier {hidden === 1 ? "entry" : "entries"}
        </button>
      ) : null}
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
      {expanded && all.length > RECENT ? (
        <button
          type="button"
          {...keyHint("activity")}
          className="activity-more"
          onClick={() => setExpanded(false)}
        >
          Show only the latest {RECENT}
        </button>
      ) : null}
    </section>
  );
}
