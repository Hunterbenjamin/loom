export type PaneViewport = {
  columns: number;
  rows: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Keep the full native screen for input coordinates, but reveal only this pane. */
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
