import { type ReactNode, type Ref, useState } from "react";

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
  actionRef,
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
  actionRef?: Ref<HTMLDivElement>;
  tab?: string;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <div
      className={`detail pr-detail ${className}`}
      data-testid={testId}
      data-task={taskId}
      data-fullscreen={fullscreen}
      ref={actionRef}
    >
      <header className="pr-page-head">
        <div className="pr-breadcrumb">{breadcrumb}</div>
        {actions}
        <button
          type="button"
          className="pr-icon-button"
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
          title="Close (Esc)"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {toolbar ? <div className="pr-toolbar">{toolbar}</div> : null}
      {banner}
      {tab ? (
        <div
          className="tab-body pr-page-body"
          id="detail-panel"
          aria-label={tab}
          role="tabpanel"
          data-tab-body={tab}
        >
          {children}
        </div>
      ) : (
        <div className="tab-body pr-page-body">{children}</div>
      )}
      {dialogs}
    </div>
  );
}
