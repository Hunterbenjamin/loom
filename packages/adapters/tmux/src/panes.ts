// tmux's `-F` output, parsed and validated before anything in core sees it. Fields are joined
// with US (0x1f) because a path may contain anything else, including a tab.

import type { PaneObservation, WorktreePath } from "@loom/core";
import { z } from "zod";
import {
  PANE_TITLE_OPTION,
  RUN_OPTION,
  SPACE_TITLE_OPTION,
  TAB_TITLE_OPTION,
  VIEW_OPTION,
} from "./config.js";

const SEP = "\u001f";

const FIELDS = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_id}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{pane_dead}",
  "#{pane_dead_status}",
  "#{pane_start_path}",
  "#{pane_current_path}",
  `#{${RUN_OPTION}}`,
  `#{${VIEW_OPTION}}`,
  "#{session_id}",
  "#{window_name}",
  "#{@loom_workspace_id}",
  "#{window_index}",
  "#{window_layout}",
  `#{${SPACE_TITLE_OPTION}}`,
  `#{${TAB_TITLE_OPTION}}`,
  `#{${PANE_TITLE_OPTION}}`,
] as const;

export const PANE_FORMAT = FIELDS.join(SEP);

const flag = z.enum(["0", "1"]).transform((v) => v === "1");

const row = z
  .tuple([
    z.string().regex(/^%\d+$/),
    z.string().min(1),
    z.string().regex(/^@\d+$/),
    z.coerce.number().int().nonnegative(),
    z.string(),
    flag,
    z.string(),
    z.string().min(1),
    z.string(),
    z.string(),
    z.string(),
    z.string().regex(/^\$\d+$/),
    z.string(),
    z.string().optional(),
    z.coerce.number().int().nonnegative().optional(),
    z.string().max(65536).optional(),
    z.string().optional(),
    z.string().optional(),
    z.string().optional(),
  ])
  .transform(
    ([
      paneId,
      sessionName,
      windowId,
      pid,
      command,
      dead,
      deadStatus,
      startPath,
      currentPath,
      runId,
      view,
      sessionId,
      windowName,
      workspaceId,
      windowIndex,
      windowLayout,
      spaceTitle,
      tabTitle,
      paneTitle,
    ]) => ({
      paneId,
      sessionName,
      windowId,
      pid,
      command,
      dead,
      sessionId,
      windowName,
      spaceTitle: spaceTitle || null,
      tabTitle: tabTitle || null,
      paneTitle: paneTitle || null,
      workspaceId: workspaceId || undefined,
      windowIndex,
      windowLayout,
      // Empty when the pane died from a signal rather than an exit status.
      exitCode: deadStatus === "" ? null : Number(deadStatus),
      startPath,
      currentPath,
      runId: runId || null,
      isView: view === "1",
    }),
  );

export type PaneRow = z.infer<typeof row>;

/** tmux prints one line per pane; a line it cannot parse is dropped, never guessed at. */
export function parsePanes(output: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parsed = row.safeParse(line.split(SEP));
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/**
 * A pane appears once per session of its session group, so a task with two attached viewers
 * lists its panes three times. Keep the row from the pane's own (non-view) session.
 */
export function dedupe(rows: PaneRow[]): PaneRow[] {
  const byPane = new Map<string, PaneRow>();
  for (const candidate of rows) {
    const existing = byPane.get(candidate.paneId);
    if (!existing || (existing.isView && !candidate.isView))
      byPane.set(candidate.paneId, candidate);
  }
  return [...byPane.values()];
}

export function toObservation(
  row: PaneRow,
  hostGeneration: string,
  startCwd: WorktreePath,
  agent: "codex" | "claude" | null = null,
): PaneObservation {
  return {
    agent,
    owner: row.runId ?? null,
    sessionId: row.sessionId,
    windowName: row.windowName,
    spaceTitle: row.spaceTitle,
    tabTitle: row.tabTitle,
    paneTitle: row.paneTitle,
    ...(row.windowIndex !== undefined ? { windowIndex: row.windowIndex } : {}),
    ...(row.windowLayout ? { windowLayout: row.windowLayout } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ref: {
      hostGeneration,
      sessionName: row.sessionName,
      windowId: row.windowId,
      paneId: row.paneId,
    },
    // tmux empties `pane_current_path` once the process is gone; `pane_start_path` survives.
    cwd: row.currentPath ? (row.currentPath as WorktreePath) : null,
    startCwd,
    pid: row.pid,
    command: row.command,
    dead: row.dead,
    exitCode: row.dead ? row.exitCode : null,
  };
}
