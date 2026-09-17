import type { BriefState, Command } from "@loom/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "./react.js";

/** Disposable readers of the coordinator-owned schedule and run history. */
export function useBriefState() {
  const store = useStoreApi();
  const connected = useStore((s) => s.connection === "connected");
  const [state, setState] = useState<BriefState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const refresh = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!connected) {
      setState(null);
      setError("Waiting for the coordinator…");
      return;
    }
    let disposed = false;
    let version = 0;
    const read = async () => {
      const request = ++version;
      const result = await store.command({ kind: "get_briefs" });
      if (disposed || request !== version) return;
      if (!result.ok) throw new Error(result.error.message);
      if (result.result.kind === "briefs") {
        setState(result.result.state);
        setError("");
      }
    };
    let loading = false;
    const poll = async () => {
      if (loading || submitting.current) return;
      loading = true;
      try {
        await read();
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Could not load briefs",
          );
      } finally {
        loading = false;
      }
    };
    refresh.current = read;
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      disposed = true;
      refresh.current = null;
      clearInterval(timer);
    };
  }, [store, connected]);
  const act = async (
    command: Extract<Command, { kind: "run_brief" | "set_brief_schedule" }>,
  ) => {
    if (!connected || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await store.command(command);
      if (!result.ok) throw new Error(result.error.message);
      await refresh.current?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return { state, error, busy, connected, act };
}
