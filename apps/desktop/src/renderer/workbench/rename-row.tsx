import { type PaneView, renameSpace, renameTab } from "@loom/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStoreApi } from "../store/react.js";

/** The draft is local; only an inventory patch changes the displayed native name. */
export function RenameRow({
  kind,
  pane,
  name,
  expanded,
  toggle,
  children,
  className = "",
  ariaLabel,
  current,
  disabled,
}: {
  kind: "space" | "tab";
  pane: PaneView | undefined;
  name: string;
  expanded?: boolean;
  ariaLabel?: string;
  current?: boolean;
  disabled?: boolean;
  toggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  const store = useStoreApi();
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const enabled =
    !!pane && !pane.unavailable && (kind === "tab" || pane.sessionId !== null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
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
          const parsed =
            kind === "space"
              ? renameSpace.safeParse({
                  kind: "rename_space",
                  hostGeneration: pane.hostGeneration,
                  sessionId: pane.sessionId,
                  name: draft,
                })
              : renameTab.safeParse({
                  kind: "rename_tab",
                  hostGeneration: pane.hostGeneration,
                  windowId: pane.windowId,
                  name: draft,
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
        {busy && <small role="status">Renaming…</small>}
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
      title={name}
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
        }
      }}
    >
      {children}
    </button>
  );
}
