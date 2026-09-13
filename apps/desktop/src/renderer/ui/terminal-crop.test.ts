import { expect, test } from "vitest";
import { paneViewports } from "../workbench/space-layout.js";
import { terminalCrop } from "./terminal-crop.js";

test("crop reveals exactly the lower right pane and excludes sibling output and borders", () => {
  const views = paneViewports(
    "abcd,120x40,0,0{60x40,0,0,2,59x40,61,0[59x20,61,0,8,59x19,61,21,9]}",
  );
  expect(views["%9"]).toEqual({
    columns: 120,
    rows: 40,
    left: 61,
    top: 21,
    width: 59,
    height: 19,
  });
  const view = views["%9"];
  if (!view) throw new Error("Missing view");
  expect(terminalCrop(view, 1200, 800, 590, 380)).toBe(
    "translate(-610px, -420px) scale(1, 1)",
  );
  expect(terminalCrop(view, 1200, 800, 295, 190)).toBe(
    "translate(-305px, -210px) scale(0.5, 0.5)",
  );
  expect(paneViewports("invalid")).toEqual({});
});
