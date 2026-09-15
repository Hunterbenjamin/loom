import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTrackerActions } from "./tracker-actions.js";
import { eventKey, keyHint, trackerKeymap } from "./tracker-keymap.js";

// A mounted nested viewer supplies its scroller; otherwise the detail body owns scrolling.
const DetailScroller = createContext<
  RefObject<HTMLDivElement | null> | undefined
>(undefined);
export function useDetailScroller() {
  return useContext(DetailScroller);
}

/** Shared chrome for issue, PR-only and daily brief details. Escape is owned by useShortcuts. */
export function DetailLayout({
  breadcrumb,
  actions,
  toolbar,
  banner,
  children,
  dialogs,
  onClose,
  testId,
  taskId,
  className = "",
  tab,
}: {
  breadcrumb: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
  dialogs?: ReactNode;
  onClose(): void;
  testId: string;
  taskId?: string;
  className?: string;
  tab?: string;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const nestedScroller = useRef<HTMLDivElement>(null);
  const scroller = () => nestedScroller.current ?? body.current;
  const scroll = (amount: number) => {
    const element = scroller();
    if (element) element.scrollTop += amount;
  };
  useTrackerActions({
    fullscreen: () => setFullscreen((value) => !value),
    "scroll-down": () => scroll(60),
    "scroll-up": () => scroll(-60),
    "half-page-down": () => scroll((scroller()?.clientHeight ?? 0) / 2),
    "half-page-up": () => scroll(-(scroller()?.clientHeight ?? 0) / 2),
    "page-down": () => scroll(scroller()?.clientHeight ?? 0),
    "page-up": () => scroll(-(scroller()?.clientHeight ?? 0)),
    top: () => {
      const element = scroller();
      if (element) element.scrollTop = 0;
    },
    bottom: () => {
      const element = scroller();
      if (element) element.scrollTop = element.scrollHeight;
    },
  });
  useEffect(() => {
    const previous = document.activeElement;
    header.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <div
      className={`detail pr-detail ${className}`}
      data-testid={testId}
      data-task={taskId}
      data-fullscreen={fullscreen}
      onKeyDownCapture={(event) => {
        // Xterm consumes Tab. F6 only returns focus to the detail chrome; it never
        // dispatches a tracker command or sends a key to the terminal process.
        if (
          !event.nativeEvent.isComposing &&
          !document.querySelector("dialog[open]") &&
          trackerKeymap
            .find((entry) => entry.id === "terminal-focus")!
            .keys.some((key) => key === eventKey(event.nativeEvent)) &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.target instanceof Element &&
          event.target.closest(".xterm")
        ) {
          event.preventDefault();
          event.stopPropagation();
          header.current?.focus();
        }
      }}
    >
      <header className="pr-page-head" ref={header} tabIndex={-1}>
        <div className="pr-breadcrumb">{breadcrumb}</div>
        {actions}
        <button
          type="button"
          className="pr-icon-button"
          {...keyHint("fullscreen")}
          data-detail-fullscreen
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-pressed={fullscreen}
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? "↙" : "⛶"}
        </button>
        <button
          type="button"
          className="pr-icon-button"
          aria-label="Close detail"
          {...keyHint("close")}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {toolbar ? <div className="pr-toolbar">{toolbar}</div> : null}
      {banner}
      {tab ? (
        <div
          ref={body}
          className="tab-body pr-page-body"
          id="detail-panel"
          aria-label={tab}
          role="tabpanel"
          data-tab-body={tab}
        >
          <DetailScroller value={nestedScroller}>{children}</DetailScroller>
        </div>
      ) : (
        <div ref={body} className="tab-body pr-page-body">
          <DetailScroller value={nestedScroller}>{children}</DetailScroller>
        </div>
      )}
      {dialogs}
    </div>
  );
}
