import type { PaneIdentity } from "@loom/protocol";
import {
  type GridviewApi,
  GridviewReact,
  type IGridviewPanelProps,
  Orientation,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "../store/react.js";
import { TerminalSession } from "../ui/terminal.js";
import { agentName } from "./selectors.js";
import { paneViewports, spaceLayout } from "./space-layout.js";
import type { Panel, Tab } from "./tabs.js";

type Rect = { left: number; top: number; width: number; height: number };

const Placeholder = ({ api }: IGridviewPanelProps) => (
  <div className="wb-cell" data-cell={api.id} />
);
const components = { cell: Placeholder };

const PanelLabel = ({
  target,
  name,
}: {
  target?: PaneIdentity;
  name?: string;
}) => {
  const pane = useStore((state) =>
    state.panes.find(
      (candidate) =>
        target &&
        candidate.hostGeneration === target.hostGeneration &&
        candidate.paneId === target.paneId,
    ),
  );
  const run = useStore((state) =>
    state.snapshot.runs.find((candidate) => candidate.id === pane?.runId),
  );
  return (
    <span>
      {target
        ? pane
          ? `${run ? agentName(pane, run) : (pane.paneTitle ?? pane.tabTitle ?? pane.windowName ?? pane.command)} · ${pane.paneId}${pane.dead ? " · exited" : pane.unavailable ? " · unavailable" : ""}`
          : "Pane unavailable"
        : (name ?? "Terminal")}
    </span>
  );
};

/** A grid lays out empty cells. Terminals are stable siblings, even when the library moves cells. */
export const TabGrid = memo(function TabGrid({
  tab,
  active,
  focused,
  focus,
  zoom,
  close,
}: {
  tab: Tab;
  active: boolean;
  focused: string;
  focus: (id: string) => void;
  zoom: string | null;
  close: (id: string) => void;
}) {
  const viewports = useMemo(() => paneViewports(tab.layout), [tab.layout]);
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<GridviewApi | null>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const live = useStore((state) => state.live);
  const theme = useStore((state) => state.ui.theme);

  const measure = useCallback(() => {
    const element = host.current;
    if (!element?.clientWidth) return;
    const base = element.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const cell of element.querySelectorAll<HTMLElement>("[data-cell]")) {
      const rect = cell.getBoundingClientRect();
      next[cell.dataset.cell as string] = {
        left: rect.left - base.left,
        top: rect.top - base.top,
        width: rect.width,
        height: rect.height,
      };
    }
    setRects((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(() => {
      const element = host.current;
      if (element?.clientWidth && element.clientHeight)
        api.current?.layout(element.clientWidth, element.clientHeight);
      measure();
    });
    if (host.current) observer.observe(host.current);
    // React grid cells can mount after the grid's layout callback. Observe only those
    // placeholders, never the terminal DOM, so newly created tabs get panel bounds.
    const cells = new MutationObserver(measure);
    const gridElement = host.current?.querySelector(".dv-grid-view");
    if (gridElement)
      cells.observe(gridElement, { childList: true, subtree: true });
    return () => {
      cells.disconnect();
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);
  const layoutSignature = JSON.stringify([tab.layout, tab.panels]);
  useEffect(() => {
    const grid = api.current;
    if (!grid) return;
    const [layout, panels] = JSON.parse(layoutSignature) as [
      string | undefined,
      Panel[],
    ];
    grid.fromJSON(spaceLayout(panels, layout));
    requestAnimationFrame(measure);
  }, [layoutSignature, measure]);
  useLayoutEffect(() => {
    if (active && host.current) {
      api.current?.layout(host.current.clientWidth, host.current.clientHeight);
      requestAnimationFrame(measure);
    }
  }, [active, measure]);
  return (
    <div
      className="wb-tab"
      ref={host}
      data-panel-host=""
      style={{ display: active ? "block" : "none" }}
    >
      <GridviewReact
        disableAutoResizing
        orientation={Orientation.HORIZONTAL}
        components={components}
        onReady={(event) => {
          api.current = event.api;
          if (host.current?.clientWidth && host.current.clientHeight)
            event.api.layout(
              host.current.clientWidth,
              host.current.clientHeight,
            );
          event.api.fromJSON(spaceLayout(tab.panels, tab.layout));
          if (host.current?.clientWidth && host.current.clientHeight)
            event.api.layout(
              host.current.clientWidth,
              host.current.clientHeight,
            );
          event.api.onDidLayoutChange(() => requestAnimationFrame(measure));
          requestAnimationFrame(measure);
        }}
      />
      {tab.panels.map((panel) => (
        <fieldset
          aria-label="Terminal panel"
          key={panel.id}
          data-panel={panel.id}
          className={`wb-panel ${focused === panel.id ? "focused" : ""}`}
          style={
            zoom === panel.id
              ? { inset: 0, zIndex: 3 }
              : {
                  ...rects[panel.id],
                  visibility:
                    !rects[panel.id] || (zoom && zoom !== panel.id)
                      ? "hidden"
                      : "visible",
                }
          }
          onFocusCapture={() => focus(panel.id)}
          onPointerDown={() => focus(panel.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const from = event.dataTransfer.getData("application/loom-panel");
            const source = api.current?.getPanel(from);
            if (!source || from === panel.id) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;
            const direction =
              Math.min(x, 1 - x) < Math.min(y, 1 - y)
                ? x < 0.5
                  ? "left"
                  : "right"
                : y < 0.5
                  ? "above"
                  : "below";
            api.current?.movePanel(source, {
              reference: panel.id,
              direction,
            });
            requestAnimationFrame(measure);
          }}
        >
          <header
            role="toolbar"
            aria-label="Panel controls"
            draggable
            onDragStart={(event) =>
              event.dataTransfer.setData("application/loom-panel", panel.id)
            }
          >
            <PanelLabel target={panel.target} name={panel.name} />
            <button
              type="button"
              aria-label="Close panel"
              title="Close and kill this terminal"
              onClick={() => close(panel.id)}
            >
              ×
            </button>
          </header>
          <TerminalSession
            panelId={panel.id}
            pane={panel.target}
            viewport={panel.target ? viewports[panel.target.paneId] : undefined}
            live={live}
            theme={theme}
            label="Workbench"
          />
        </fieldset>
      ))}
    </div>
  );
});
