import { useEffect, useRef, useState } from "react";

export function NewTerminalDialog({
  initialName,
  create,
  cancel,
  kind = "terminal",
}: {
  initialName: string;
  create: (name: string) => Promise<void>;
  cancel: () => void;
  kind?: "terminal" | "space";
}) {
  const noun = kind === "space" ? "space" : "terminal";
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="wb-new-terminal"
      aria-labelledby="new-terminal-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          void create(name.trim()).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
          });
        }}
      >
        <h2 id="new-terminal-title">New {noun}</h2>
        <label htmlFor="terminal-name">
          {kind === "space" ? "Space name" : "Terminal name"}
        </label>
        <input
          ref={input}
          id="terminal-name"
          value={name}
          maxLength={80}
          required
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <div>
          <button type="button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : `Create ${noun}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
