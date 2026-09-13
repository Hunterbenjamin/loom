import { automate } from "./automation.js";
import { Context } from "./context.js";
import { delivery } from "./delivery.js";
import { attention, budget, reconcileFlags } from "./flags.js";
import { structurallyEqual } from "./helpers.js";
import { human } from "./human.js";
import { observeRuns, retireFinishedPanes, startDesired } from "./lifecycle.js";
import type { Reconcile } from "./reconcile.js";
import { actionResult, retryActions } from "./results.js";
import { reconcileStages } from "./stages.js";
import { submission } from "./submissions.js";

export const reconcile: Reconcile = (state, observations) => {
  const c = new Context(state, observations);
  budget(c);
  observeRuns(c);
  // Observed merge/head/CI changes win over commands submitted against an old snapshot.
  reconcileStages(c);
  reconcileFlags(c);
  const consumed = new Set(c.state.consumedInputIds);
  for (const input of observations.inputs) {
    if (consumed.has(input.id)) continue;
    c.trigger =
      input.type === "human"
        ? { kind: "human", command: input.command.type, inputId: input.id }
        : input.type === "mcp"
          ? {
              kind: "mcp",
              tool: input.call.tool,
              runId: input.runId,
              inputId: input.id,
            }
          : { kind: "reconcile", fact: `action_result:${input.key}` };
    if (input.type === "mcp") {
      const result = submission(c, input);
      c.result.inputs.push(
        "code" in result
          ? { inputId: input.id, accepted: false, error: result }
          : { inputId: input.id, accepted: true, reply: result },
      );
    } else {
      const failure =
        input.type === "human"
          ? human(c, input.command, input.id)
          : actionResult(c, input);
      c.result.inputs.push(
        failure
          ? { inputId: input.id, accepted: false, error: failure }
          : { inputId: input.id, accepted: true, reply: null },
      );
    }
    consumed.add(input.id);
  }
  c.state.consumedInputIds = [...consumed];
  c.trigger = { kind: "reconcile", fact: "observations" };
  // Results can unlock a new session; hydrate it in this pass to reach a fixed point.
  observeRuns(c);
  reconcileStages(c);
  reconcileFlags(c);
  retryActions(c);
  if (
    (c.state.findings.length || c.state.artifactContents.findings) &&
    !structurallyEqual(c.state.artifactContents.findings, c.state.findings)
  ) {
    c.artifact("findings", c.state.findings);
    c.files();
  }
  startDesired(c);
  retireFinishedPanes(c);
  delivery(c);
  automate(c);
  attention(c);
  if (!structurallyEqual(c.state, state)) {
    c.task.version = state.task.version + 1;
    c.task.updatedAt = c.now;
  }
  return c.result;
};
