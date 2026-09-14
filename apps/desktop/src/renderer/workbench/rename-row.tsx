import { type PaneView, setTitle } from "@loom/protocol";
import {
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useStoreApi } from "../store/react.js";

/** The draft is local; only an inventory patch changes the displayed title. */
export function RenameRow({
  kind,
  pane,
  name,
  title,
  expanded,
  toggle,
  children,
  className = "",
  ariaLabel,
  current,
  disabled,
  editing: controlledEditing,
  onEditingChange,
  onContextMenu,
  onKeyDown,
  dataPaneKey,
}: {
  kind: "space" | "tab" | "pane";
  pane: PaneView | undefined;
  name: string;
  title: string | null;
  expanded?: boolean;
  ariaLabel?: string;
  current?: boolean;
  disabled?: boolean;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  dataPaneKey?: string;
  toggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  const store = useStoreApi();
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [internalEditing, setInternalEditing] = useState(false);
  const editing = controlledEditing ?? internalEditing;
  const setEditing = (value: boolean) => {
    setInternalEditing(value);
    onEditingChange?.(value);
  };
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const enabled =
    !!pane &&
    !pane.unavailable &&
    (kind !== "space" || pane.sessionId !== null);
  useEffect(() => {
    if (editing) {
      setDraft(name);
      setError("");
      input.current?.focus();
      input.current?.select();
    }
  }, [editing, name]);
  const begin = () => {
    if (!enabled) return;
    setDraft(name);
    setError("");
    setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    requestAnimationFrame(() => button.current?.focus());
  };
  if (editing)
    return (
      <form
        className="wb-rename"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (pending.current || !pane) return;
          if (title === null && draft.trim() === name.trim()) {
            finish();
            return;
          }
          const target =
            kind === "space"
              ? { kind, sessionId: pane.sessionId }
              : kind === "tab"
                ? { kind, windowId: pane.windowId }
                : { kind, paneId: pane.paneId };
          const parsed = setTitle.safeParse({
            kind: "set_title",
            hostGeneration: pane.hostGeneration,
            target,
            title: draft,
          });
          if (!parsed.success) {
            setError(
              parsed.error.issues.map((issue) => issue.message).join("; "),
            );
            return;
          }
          pending.current = true;
          setBusy(true);
          setError("");
          void store
            .command(parsed.data)
            .then((result) => {
              if (!result.ok)
                throw new Error(
                  [result.error.message, ...result.error.details].join("; "),
                );
              finish();
            })
            .catch((error: unknown) => {
              setError(error instanceof Error ? error.message : String(error));
              requestAnimationFrame(() => input.current?.focus());
            })
            .finally(() => {
              pending.current = false;
              setBusy(false);
            });
        }}
      >
        <input
          ref={input}
          aria-label={`Rename ${kind}`}
          aria-invalid={!!error}
          aria-describedby={
            error ? `rename-error-${pane?.paneId}-${kind}` : undefined
          }
          value={draft}
          readOnly={busy}
          maxLength={80}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              if (!pending.current) finish();
            }
          }}
        />
        {busy && <small role="status">Saving…</small>}
        {error && (
          <small id={`rename-error-${pane?.paneId}-${kind}`} role="alert">
            {error}
          </small>
        )}
      </form>
    );
  return (
    <button
      ref={button}
      type="button"
      className={`wb-tree-row ${className}`}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      aria-current={current ? "true" : undefined}
      disabled={disabled}
      data-pane-key={dataPaneKey}
      title={name}
      onContextMenu={onContextMenu}
      onClick={(event) => {
        // The second click starts editing; it must not open a second split group.
        if (event.detail < 2) toggle();
      }}
      onDoubleClick={begin}
      onKeyDown={(event) => {
        if (event.key === "F2") {
          event.preventDefault();
          event.stopPropagation();
          begin();
          return;
        }
        onKeyDown?.(event);
      }}
    >
      {children}
    </button>
  );
}
