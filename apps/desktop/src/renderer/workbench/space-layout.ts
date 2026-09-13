import type { PaneIdentity } from "@loom/protocol";
import { type GridviewApi, Orientation } from "dockview";

type Cell = {
  width: number;
  height: number;
  left: number;
  top: number;
  pane?: string;
  direction?: "horizontal" | "vertical";
  children: Cell[];
};

/** Decode tmux's native layout grammar, never terminal text. Malformed/old inventory falls back. */
function parseLayout(layout: string): Cell {
  let rest = layout.replace(/^[0-9a-f]{4},/i, "");
  const read = (depth = 0): Cell => {
    if (depth > 64) throw new Error("Layout too deep");
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(rest);
    if (!match) throw new Error("Invalid layout cell");
    rest = rest.slice(match[0].length);
    const cell: Cell = {
      width: Number(match[1]),
      height: Number(match[2]),
      left: Number(match[3]),
      top: Number(match[4]),
      children: [],
    };
    if (!cell.width || !cell.height) throw new Error("Empty layout cell");
    if (rest[0] === "{" || rest[0] === "[") {
      const end = rest[0] === "{" ? "}" : "]";
      cell.direction = rest[0] === "{" ? "horizontal" : "vertical";
      rest = rest.slice(1);
      cell.children.push(read(depth + 1));
      while (rest[0] === ",") {
        rest = rest.slice(1);
        cell.children.push(read(depth + 1));
      }
      if (rest[0] !== end) throw new Error("Unclosed layout cell");
      rest = rest.slice(1);
    } else {
      const pane = /^,(\d+)/.exec(rest);
      if (!pane) throw new Error("Missing pane");
      cell.pane = `%${pane[1]}`;
      rest = rest.slice(pane[0].length);
    }
    return cell;
  };
  const root = read();
  if (rest) throw new Error("Trailing layout data");
  return root;
}

export function spaceLayout(
  panels: { id: string; target?: PaneIdentity }[],
  layout?: string,
): ReturnType<GridviewApi["toJSON"]> {
  type Node = ReturnType<GridviewApi["toJSON"]>["grid"]["root"];
  const leaf = (id: string, size: number): Node => ({
    type: "leaf",
    size,
    data: { id, component: "cell", minimumWidth: 80, minimumHeight: 60 },
  });
  const fallback = (): ReturnType<GridviewApi["toJSON"]> => ({
    grid: {
      width: panels.length * 100,
      height: 100,
      orientation: Orientation.HORIZONTAL,
      root: {
        type: "branch",
        size: 100,
        data: panels.map((p) => leaf(p.id, 100)),
      },
    },
  });
  if (!layout) return fallback();
  try {
    const root = parseLayout(layout);
    const remaining = new Map(panels.map((p) => [p.target?.paneId, p.id]));
    const convert = (
      cell: Cell,
      direction: "horizontal" | "vertical",
      size: number,
    ): Node | null => {
      if (cell.pane) {
        const id = remaining.get(cell.pane);
        if (!id) return null;
        remaining.delete(cell.pane);
        return leaf(id, size);
      }
      if (cell.direction !== direction) {
        const child = convert(
          cell,
          direction === "horizontal" ? "vertical" : "horizontal",
          direction === "horizontal" ? cell.width : cell.height,
        );
        return child ? { type: "branch", size, data: [child] } : null;
      }
      const data = cell.children
        .map((c) =>
          convert(
            c,
            direction === "horizontal" ? "vertical" : "horizontal",
            direction === "horizontal" ? c.width : c.height,
          ),
        )
        .filter((n): n is Node => n !== null);
      return data.length ? { type: "branch", size, data } : null;
    };
    const direction = root.direction ?? "horizontal";
    const node = convert(
      root,
      direction,
      direction === "horizontal" ? root.height : root.width,
    );
    if (!node || remaining.size) return fallback();
    return {
      grid: {
        width: root.width,
        height: root.height,
        orientation:
          direction === "horizontal"
            ? Orientation.HORIZONTAL
            : Orientation.VERTICAL,
        root:
          node.type === "branch"
            ? node
            : { type: "branch", size: root.height, data: [node] },
      },
    };
  } catch {
    return fallback();
  }
}

/** Each xterm client draws a whole window; crop it to the pane's native cell rectangle. */
export function paneViewports(
  layout?: string,
): Record<string, import("../ui/terminal-crop.js").PaneViewport> {
  if (!layout) return {};
  try {
    const root = parseLayout(layout);
    const result: ReturnType<typeof paneViewports> = {};
    const visit = (cell: Cell) => {
      if (cell.pane)
        result[cell.pane] = {
          columns: root.width,
          rows: root.height,
          left: cell.left,
          top: cell.top,
          width: cell.width,
          height: cell.height,
        };
      else cell.children.forEach(visit);
    };
    visit(root);
    return result;
  } catch {
    return {};
  }
}
