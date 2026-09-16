import type { KeyboardEvent, ReactNode } from "react";

export function stopButtonShortcut(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

export function ListToolbar({ children }: { children?: ReactNode }) {
  return (
    <div className="list-toolbar reviews-toolbar">
      <div className="list-segments reviews-tabs">{children}</div>
    </div>
  );
}

export function ListGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  cursor = false,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle?: () => void;
  cursor?: boolean;
}) {
  return (
    <button
      type="button"
      className="list-group reviews-group"
      data-cursor={cursor}
      aria-expanded={!collapsed}
      onClick={onToggle}
      onKeyDown={stopButtonShortcut}
    >
      <span>{label}</span>
      <span className="nums">{count}</span>
      {onToggle ? (
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
      ) : null}
    </button>
  );
}

export function ListRow({
  cursor,
  onOpen,
  leading,
  text,
  meta,
  age,
  title,
  children,
  ...data
}: {
  cursor: boolean;
  onOpen: () => void;
  leading: ReactNode;
  text: ReactNode;
  meta?: ReactNode;
  age?: ReactNode;
  title?: string;
  children?: ReactNode;
  id?: string;
  [key: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row delegates keyboard focus to its roving open button.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is handled by the open button.
    <div
      className="list-row review-row"
      data-cursor={cursor}
      onClick={onOpen}
      {...data}
    >
      <button
        type="button"
        className="list-row-open review-row-open"
        tabIndex={cursor ? 0 : -1}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onKeyDown={stopButtonShortcut}
        title={title}
      >
        {leading}
        <span className="text">{text}</span>
      </button>
      {children}
      {meta ? <span className="list-row-meta">{meta}</span> : null}
      {age ? <span className="faint nums list-row-age">{age}</span> : null}
    </div>
  );
}

export function LoadMore({
  cursor = false,
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
  cursor?: boolean;
}) {
  return (
    <button
      type="button"
      className="list-load-more"
      data-cursor={cursor}
      onClick={onClick}
      onKeyDown={stopButtonShortcut}
    >
      {label}
    </button>
  );
}
