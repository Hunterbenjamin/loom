export type PaneViewport = {
  columns: number;
  rows: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Keep the full native screen for input coordinates, but reveal only this pane. */
/**
 * What history to replay for a view of a pane. A view shows a slice of the window's screen, and
 * history scrolls in above the screen, so only a pane at the top of its window can show its own:
 * for a pane below another, the rows above it belong to that other pane.
 */
export function historyRequest(
  view: PaneViewport | undefined,
  lines: number,
): { lines: number; join: boolean; column: number } {
  if (!view) return { lines, join: true, column: 0 };
  if (view.top > 0) return { lines: 0, join: false, column: 0 };
  return {
    lines,
    join: view.left === 0 && view.width === view.columns,
    column: view.left,
  };
}

export function terminalCrop(
  view: PaneViewport,
  screenWidth: number,
  screenHeight: number,
  width: number,
  height: number,
): string {
  const cellWidth = screenWidth / view.columns;
  const cellHeight = screenHeight / view.rows;
  const scaleX = width / (view.width * cellWidth);
  const scaleY = height / (view.height * cellHeight);
  return `translate(${-view.left * cellWidth * scaleX}px, ${-view.top * cellHeight * scaleY}px) scale(${scaleX}, ${scaleY})`;
}
