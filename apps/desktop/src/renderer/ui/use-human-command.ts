import type { HumanCommand, TaskId } from "@loom/core";
import { useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { stageLabel } from "./format.js";

export type HumanCommandOutcome =
  | { kind: "idle"; message: "" }
  | { kind: "sending"; message: string }
  | { kind: "queued"; message: string }
  | { kind: "applied"; message: string }
  | { kind: "refused"; message: string };

export function useHumanCommand(taskId: TaskId) {
  const store = useStoreApi();
  const submitting = useRef(false);
  const input = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<HumanCommandOutcome>({
    kind: "idle",
    message: "",
  });
  const transition = useStore((state) =>
    input.current
      ? state.snapshot.transitions.find(
          (item) =>
            item.taskId === taskId &&
            item.trigger.kind === "human" &&
            item.trigger.inputId === input.current,
        )
      : undefined,
  );
  useEffect(() => {
    if (!transition) return;
    setOutcome({
      kind: "applied",
      message:
        transition.from === transition.to
          ? transition.reason
          : `Applied: ${stageLabel(transition.from)} → ${stageLabel(transition.to)}`,
    });
  }, [transition]);

  const send = async (command: HumanCommand) => {
    if (submitting.current) return;
    submitting.current = true;
    input.current = null;
    setOutcome({ kind: "sending", message: "Waiting for coordinator…" });
    try {
      const result = await store.command({ kind: "human", taskId, command });
      if (!result.ok) {
        const next: HumanCommandOutcome = {
          kind: "refused",
          message: [
            `${result.error.code}: ${result.error.message}`,
            ...result.error.details,
          ].join("\n"),
        };
        setOutcome(next);
        return next;
      } else if (result.result.kind === "human") {
        input.current = result.result.inputId;
        const next: HumanCommandOutcome = {
          kind: "queued",
          message: "Queued. Waiting for the coordinator to apply it…",
        };
        setOutcome(next);
        return next;
      } else {
        const next: HumanCommandOutcome = {
          kind: "applied",
          message: "Coordinator acknowledged the action.",
        };
        setOutcome(next);
        return next;
      }
    } catch (error) {
      const next: HumanCommandOutcome = {
        kind: "refused",
        message: error instanceof Error ? error.message : "The action failed",
      };
      setOutcome(next);
      return next;
    } finally {
      submitting.current = false;
    }
  };
  return { send, outcome, submitting: outcome.kind === "sending" };
}
