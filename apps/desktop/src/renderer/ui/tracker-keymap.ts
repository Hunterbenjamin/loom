import { scrollBindings } from "./scroll-keys.js";

export { eventKey } from "./event-key.js";
/** Tracker bindings are separate from editable Workbench bindings. */
export const trackerKeymap = [
  {
    id: "help",
    keys: ["?"],
    label: "Keyboard map",
    group: "Everywhere",
    scope: "global",
  },
  {
    id: "palette",
    keys: ["Meta+k", "Control+k"],
    label: "Command palette",
    group: "Everywhere",
    scope: "global",
  },
  {
    id: "close",
    keys: ["Escape"],
    label: "Close overlay or detail",
    group: "Everywhere",
    scope: "global",
  },
  {
    id: "create",
    keys: ["c"],
    label: "Create issue",
    group: "Everywhere",
    scope: "global",
  },
  ...(
    [
      ["all", "i", "Issues"],
      ["needs-you", "n", "Inbox"],
      ["pull-requests", "r", "Review"],
      ["briefs", "d", "Daily brief"],
      ["settings", "s", "Settings"],
    ] as const
  ).map(([view, key, label]) => ({
    id: `go-${view}` as const,
    keys: [`g ${key}`],
    label,
    group: "Go to",
    scope: "global" as const,
  })),
  {
    id: "next-row",
    keys: ["j"],
    label: "Next row / card",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "previous-row",
    keys: ["k"],
    label: "Previous row / card",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "first-row",
    keys: ["g g"],
    label: "First row / card in column",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "last-row",
    keys: ["G"],
    label: "Last row / card in column",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "open",
    keys: ["Enter"],
    label: "Open selected row",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "filter",
    keys: ["/"],
    label: "Filter list",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "view",
    keys: ["v"],
    label: "Toggle List / Board (Issues, Inbox)",
    group: "Lists and board",
    scope: "list",
  },
  {
    id: "stage",
    keys: ["s"],
    label: "Change issue stage",
    group: "Issues",
    scope: "issue",
  },
  {
    id: "left-column",
    keys: ["h"],
    label: "Previous column",
    group: "Board",
    scope: "board",
  },
  {
    id: "right-column",
    keys: ["l"],
    label: "Next column",
    group: "Board",
    scope: "board",
  },
  {
    id: "next-issue",
    keys: ["]"],
    label: "Next issue",
    group: "Detail",
    scope: "detail",
  },
  {
    id: "previous-issue",
    keys: ["["],
    label: "Previous issue",
    group: "Detail",
    scope: "detail",
  },
  ...(["overview", "plan", "diff", "terminal"] as const).map((tab, i) => ({
    id: `tab-${tab}` as const,
    keys: [String(i + 1)],
    label: `${tab} tab (when available)`,
    group: "Detail",
    scope: "detail" as const,
  })),
  ...scrollBindings.map((entry) => ({
    id: entry.id,
    keys: entry.keys,
    label: entry.label,
    group: "Reading",
    scope: entry.id === "leave" ? ("terminal" as const) : ("detail" as const),
  })),
  {
    id: "activity",
    keys: ["z"],
    label: "Toggle earlier activity",
    group: "Detail",
    scope: "detail",
  },
  {
    id: "findings",
    keys: ["f"],
    label: "Toggle findings",
    group: "Detail",
    scope: "detail",
  },
  {
    id: "fullscreen",
    keys: ["F"],
    label: "Toggle fullscreen",
    group: "Detail",
    scope: "detail",
  },
  {
    id: "edit",
    keys: ["e"],
    label: "Edit Backlog issue",
    group: "Issue detail",
    scope: "detail",
  },
  {
    id: "approve",
    keys: ["a"],
    label: "Confirm plan / merge approval",
    group: "Issue detail",
    scope: "detail",
  },
  {
    id: "change",
    keys: ["x"],
    label: "Change plan / request changes",
    group: "Issue detail",
    scope: "detail",
  },
  {
    id: "merge",
    keys: ["m", "Meta+Enter"],
    label: "Confirm merge",
    group: "Pull request",
    scope: "detail",
  },
  {
    id: "delete",
    keys: ["d"],
    label: "Delete branch",
    group: "Pull request",
    scope: "detail",
  },
  {
    id: "github",
    keys: ["o"],
    label: "Open on GitHub",
    group: "Pull request",
    scope: "detail",
  },
  {
    id: "refresh",
    keys: ["r"],
    label: "Refresh pull request",
    group: "Pull request",
    scope: "detail",
  },
  {
    id: "next-file",
    keys: ["n"],
    label: "Next file",
    group: "Diff (takes precedence)",
    scope: "diff",
  },
  {
    id: "previous-file",
    keys: ["p"],
    label: "Previous file",
    group: "Diff (takes precedence)",
    scope: "diff",
  },
  {
    id: "reviewed",
    keys: ["v"],
    label: "Toggle reviewed",
    group: "Diff (takes precedence)",
    scope: "diff",
  },
  {
    id: "next-hunk",
    keys: ["]"],
    label: "Next hunk",
    group: "Diff (takes precedence)",
    scope: "diff",
  },
  {
    id: "previous-hunk",
    keys: ["["],
    label: "Previous hunk",
    group: "Diff (takes precedence)",
    scope: "diff",
  },
  {
    id: "terminal-focus",
    keys: ["F6"],
    label: "Leave terminal input",
    group: "Terminal",
    scope: "terminal",
  },
] as const;
export type TrackerActionId = (typeof trackerKeymap)[number]["id"];
export function formatKeys(id: TrackerActionId): string {
  return trackerKeymap
    .find((entry) => entry.id === id)!
    .keys.map((key) =>
      key
        .replace(
          /Meta\+([a-z])/,
          (_, letter: string) => `⌘${letter.toUpperCase()}`,
        )
        .replace(
          /Control\+([a-z])/,
          (_, letter: string) => `Ctrl+${letter.toUpperCase()}`,
        )
        .replace("Meta+", "⌘")
        .replace("Control+", "Ctrl+")
        .replace("Escape", "Esc"),
    )
    .join(" / ");
}
export function keyHint(id: TrackerActionId, label?: string | null) {
  const entry = trackerKeymap.find((entry) => entry.id === id)!;
  return {
    title: `${label ?? entry.label} (${formatKeys(id)})`,
    "aria-keyshortcuts":
      entry.keys
        .filter((key) => !key.includes(" "))
        .map((key) =>
          /^[A-Z]$/.test(key) ? `Shift+${key.toLowerCase()}` : key,
        )
        .join(" ") || undefined,
  };
}
