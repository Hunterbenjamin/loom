import type { KeyboardEvent, ReactNode, RefObject } from "react";

export function stopButtonShortcut(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

export function ListToolbar({
  children,
  query,
  onQuery,
  inputRef,
  label = "Filter",
}: {
  children: ReactNode;
  query?: string;
  onQuery?: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  label?: string;
}) {
  return (
    <div className="list-toolbar reviews-toolbar">
      <div className="list-segments reviews-tabs">{children}</div>
      {onQuery ? (
        <div className="list-search reviews-search" data-active={!!query}>
          <input
            ref={inputRef}
            data-pr-search
            aria-label={label}
            placeholder={`${label}…`}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onQuery("");
                event.currentTarget.blur();
                event.stopPropagation();
              }
            }}
          />
          <button
            type="button"
            aria-label={label}
            title={`${label} (/)`}
            onClick={() => inputRef?.current?.focus()}
            onKeyDown={stopButtonShortcut}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M2 4h12M4 8h8M6 12h4" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ListGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      className="list-group reviews-group"
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
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="list-load-more"
      onClick={onClick}
      onKeyDown={stopButtonShortcut}
    >
      {label}
    </button>
  );
}
