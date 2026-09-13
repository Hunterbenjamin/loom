import { describe, expect, it, test } from "vitest";
import { paneViewports } from "../workbench/space-layout.js";
import { historyRequest, terminalCrop } from "./terminal-crop.js";

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

describe("historyRequest", () => {
  it("replays a whole window's pane with wrapped lines joined", () => {
    expect(historyRequest(undefined, 500)).toEqual({
      lines: 500,
      join: true,
      column: 0,
    });
    expect(
      historyRequest(
        { columns: 100, rows: 40, left: 0, top: 0, width: 100, height: 40 },
        500,
      ),
    ).toEqual({ lines: 500, join: true, column: 0 });
  });
  it("keeps a narrower pane's wrapping and places its lines at its column", () => {
    expect(
      historyRequest(
        { columns: 100, rows: 40, left: 51, top: 0, width: 49, height: 40 },
        500,
      ),
    ).toEqual({ lines: 500, join: false, column: 51 });
  });
  it("replays nothing for a pane below another", () => {
    expect(
      historyRequest(
        { columns: 100, rows: 40, left: 0, top: 21, width: 100, height: 19 },
        500,
      ),
    ).toEqual({ lines: 0, join: false, column: 0 });
  });
});
