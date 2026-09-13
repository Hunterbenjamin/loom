// @vitest-environment happy-dom
import { type GridviewApi, GridviewReact, Orientation } from "dockview";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { spaceLayout } from "./space-layout.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const panels = [2, 8, 9].map((n) => ({
  id: `panel-${n}`,
  target: { ...pane, paneId: `%${n}` },
}));
test("native mixed layout maps to Dockview splits and proportions", async () => {
  const layout = spaceLayout(
    panels,
    "abcd,120x40,0,0{60x40,0,0,2,59x40,61,0[59x20,61,0,8,59x19,61,21,9]}",
  );
  expect(layout).toMatchSnapshot();
  const element = document.createElement("div");
  document.body.append(element);
  let api: GridviewApi | undefined;
  const root = createRoot(element);
  await act(async () =>
    root.render(
      createElement(GridviewReact, {
        orientation: Orientation.HORIZONTAL,
        components: { cell: () => createElement("div") },
        onReady: (event) => {
          api = event.api;
        },
      }),
    ),
  );
  const grid = api as unknown as GridviewApi;
  try {
    grid.layout(1200, 800);
    await act(async () => grid.fromJSON(layout));
    expect(grid.panels.map((p) => p.id)).toEqual([
      "panel-2",
      "panel-8",
      "panel-9",
    ]);
    const left = grid.getPanel("panel-2");
    const top = grid.getPanel("panel-8");
    const bottom = grid.getPanel("panel-9");
    expect(left?.height).toBeGreaterThan((top?.height ?? 0) * 1.9);
    expect(top?.width).toBe(bottom?.width);
    expect(Math.abs((left?.width ?? 0) - (top?.width ?? 0))).toBeLessThan(30);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
test("vertical, unavailable panes and invalid layouts retain safe complete viewers", () => {
  expect(
    spaceLayout(panels.slice(1), "abcd,120x40,0,0[120x20,0,0,8,120x19,0,21,9]")
      .grid.orientation,
  ).toBe(Orientation.VERTICAL);
  expect(
    spaceLayout(
      panels.slice(1),
      "abcd,120x40,0,0{60x40,0,0,2,59x40,61,0[59x20,61,0,8,59x19,61,21,9]}",
    ),
  ).toMatchSnapshot();
  for (const invalid of [
    undefined,
    "garbage",
    "abcd,120x40,0,0[",
    "abcd,0x0,0,0,2",
  ]) {
    expect(spaceLayout(panels, invalid)).toEqual(spaceLayout(panels));
  }
});
