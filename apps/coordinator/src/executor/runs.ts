import { isStaleEntry } from "@loom/adapter-claude";
import type {
  Action,
  ActionOutputs,
  IsoTime,
  PaneHost,
  PaneRef,
  TaskState,
} from "@loom/core";
import { deriveStatus } from "@loom/core";
import { checkPanePromptGate, checkSendGate } from "../gate.js";
import { codexThreadConfig, relaunchFromRecipe, startRun } from "../launch.js";
import { observeRun } from "../observe.js";
import type { ExecutorDeps } from "./deps.js";
import { Fatal, PreconditionFailed } from "./errors.js";

export async function pressPaneChoice(
  paneHost: PaneHost,
  pane: PaneRef,
  choice: number | "enter" | "escape",
): Promise<void> {
  if (typeof choice === "number") {
    await paneHost.pasteText(pane, String(choice));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await paneHost.sendKey(pane, "Enter");
  } else await paneHost.sendKey(pane, choice === "enter" ? "Enter" : "Escape");
}

export class RunActions {
  constructor(private readonly deps: ExecutorDeps) {}

  async perform(
    action: Extract<
      Action,
      {
        kind:
          | "open_workspace"
          | "start_run"
          | "send_message"
          | "interrupt_run"
          | "answer_pane_prompt"
          | "answer_provider_request"
          | "stop_run";
      },
    >,
    state: TaskState,
  ): Promise<unknown> {
    const { adapters } = this.deps;
    switch (action.kind) {
      case "open_workspace":
        return adapters.paneHost.ensureWorkspace({
          taskId: action.taskId,
          cwd: action.worktreePath,
          label: action.label,
        });
      case "start_run":
        return startRun(this.deps.launch, action, state);
      case "send_message":
        return this.send(action, state);
      case "interrupt_run":
        return this.interrupt(action, state);
      case "answer_pane_prompt":
        return this.answerPanePrompt(action, state);
      case "answer_provider_request": {
        const run = this.run(state, action.runId);
        if (!run.sessionId)
          throw new PreconditionFailed("The run has no recorded session");
        const codex = await adapters.codex(action.taskId);
        const generation = action.generation ?? codex.generation();
        if (generation === null || generation !== codex.generation())
          throw new PreconditionFailed(
            "The app-server generation changed; request IDs restart with the server",
          );
        await codex.answerRequest({
          threadId: run.sessionId,
          generation,
          requestId: action.requestId,
          decision: action.decision,
          answers: action.answers,
        });
        return {};
      }
      case "stop_run": {
        // Task state holds only each role's latest ended run, so a retire that ran late (behind a
        // merge, say) can target a run a newer one of its role has replaced. Stop that one too.
        const run =
          state.runs.find((r) => r.id === action.runId) ??
          this.deps.store
            .runs(action.taskId)
            .find((r) => r.id === action.runId) ??
          this.run(state, action.runId);
        if (action.retire) {
          // The run has ended and its role is done: kill the pane, keep the session resumable.
          if (run.pane) await adapters.paneHost.closePane(run.pane);
          return {};
        }
        if (action.terminate) {
          if (
            run.origin !== "loom" ||
            !["superseded", "failed"].includes(run.endReason ?? "")
          )
            throw new Fatal(
              "Only a superseded or human-retried Loom run can be retired for replacement",
            );
          if (run.sessionId && run.provider === "codex") {
            const codex = await adapters.codex(action.taskId);
            const sessionId = run.sessionId;
            const read = async () => {
              try {
                return await codex.readThread(sessionId);
              } catch (error) {
                if ((await codex.checkResumable(sessionId)) === false)
                  return null;
                throw error;
              }
            };
            // A coordinator that restarted after this run ended has not resumed its thread, and
            // the adapter refuses to read an unresumed thread. Resume first; a thread that is
            // gone falls through to the resumable check below.
            const recipe = this.deps.launch.recipes.get(run.id);
            await codex
              .resumeThread(
                sessionId,
                recipe
                  ? {
                      config: codexThreadConfig(
                        this.deps.launch.mcpEntry(recipe.token),
                        run.reasoningEffort,
                      ),
                    }
                  : undefined,
              )
              .catch(() => undefined);
            let observation = await read();
            const turn = observation?.turns.at(-1);
            if (turn?.status === "inProgress") {
              await codex.interruptTurn({
                threadId: run.sessionId,
                turnId: turn.id,
              });
              observation = await read();
            }
            if (
              observation?.status === "active" ||
              observation?.turns.at(-1)?.status === "inProgress"
            )
              throw new Error(
                "Waiting for the previous Codex turn to stop before replacement",
              );
            if (observation) await codex.unsubscribe(run.sessionId);
          } else if (run.sessionId && run.mode === "headless") {
            await adapters.claude.closeHeadless(run.sessionId);
            const entry = (await adapters.claude.listSessions()).find(
              (s) => s.sessionId === run.sessionId,
            );
            if (entry && !isStaleEntry(entry))
              throw new Error(
                "Waiting for the previous Claude process to exit before replacement",
              );
          }
          if (run.pane) await adapters.paneHost.closePane(run.pane);
          else if (
            run.sessionId &&
            run.provider === "claude" &&
            run.mode === "interactive"
          ) {
            const observed = await observeRun(adapters, this.deps.now(), run);
            if (
              !observed.provider.ok ||
              (observed.provider.value?.provider === "claude" &&
                observed.provider.value.agentsEntry)
            )
              throw new Error(
                "Cannot retire a live Claude session without its recorded pane",
              );
          }
          return {};
        }
        if (!run.sessionId) return {};
        if (run.provider === "codex")
          await (await adapters.codex(action.taskId)).unsubscribe(
            run.sessionId,
          );
        else if (run.mode === "headless") {
          // Closing terminates the subprocess directly; an interrupt RPC can hang after exit.
          // Let failures reach the outbox so cleanup can be retried.
          await adapters.claude.closeHeadless(run.sessionId);
        }
        return {};
      }
    }
  }

  private run(state: TaskState, runId: string) {
    const run = state.runs.find((r) => r.id === runId);
    if (!run) throw new Fatal(`Unknown run ${runId}`);
    return run;
  }

  /** The send gate, then the transport. Delivery is never inferred from what the transport says. */
  private async send(
    action: Extract<Action, { kind: "send_message" }>,
    state: TaskState,
  ): Promise<ActionOutputs["send_message"]> {
    const { adapters } = this.deps;
    const run = this.run(state, action.runId);
    const decision = await checkSendGate(
      adapters,
      this.deps.now(),
      run,
      action,
    );
    if (!decision.ok)
      throw new PreconditionFailed(`Refusing to send: ${decision.reason}`);
    const sessionId = run.sessionId;
    if (!sessionId) throw new PreconditionFailed("The run has no session");
    const startedAt = this.deps.now() as IsoTime;
    const transport = async (): Promise<{ transportRef: string | null }> => {
      switch (action.via) {
        case "codex_turn_start": {
          const codex = await adapters.codex(action.taskId);
          return {
            transportRef: (
              await codex.startTurn({
                threadId: sessionId,
                text: action.text,
                images: action.images,
                model: run.model,
                ...(run.reasoningEffort ? { effort: run.reasoningEffort } : {}),
              })
            ).turnId,
          };
        }
        case "codex_turn_steer": {
          const codex = await adapters.codex(action.taskId);
          if (!action.expectedTurnId)
            throw new PreconditionFailed("A steer needs an expected turn");
          return {
            transportRef: (
              await codex.steerTurn({
                threadId: sessionId,
                expectedTurnId: action.expectedTurnId,
                text: action.text,
                images: action.images,
              })
            ).turnId,
          };
        }
        case "claude_sdk":
          await adapters.claude.sendHeadless({ sessionId, text: action.text });
          return { transportRef: null };
        case "pane_paste": {
          if (!run.pane)
            throw new PreconditionFailed("The run has no pane to write into");
          // The host refuses a leading `/` or `!` itself; core never generates one either.
          await adapters.paneHost.pasteText(run.pane, action.text);
          return { transportRef: null };
        }
      }
    };
    const output = await transport();
    // A Codex TUI attaches with `codex resume`, which fails until the thread has its first turn;
    // a pane launched before that message may have died in the race. Now that the message is in,
    // put the pane back from its recipe. Only the pane changes; the thread is untouched.
    if (run.mode === "interactive" && run.provider === "codex") {
      let live = null;
      let paneReadFailed = false;
      if (run.pane)
        try {
          live = await adapters.paneHost.getPane(run.pane);
        } catch (error) {
          paneReadFailed = true;
          this.deps.reportAdapterFailure?.(
            `Post-delivery pane read for ${run.id}`,
            error,
          );
        }
      const recipe = this.deps.launch.recipes.get(run.id);
      const workspaceId = state.worktree?.paneWorkspaceId;
      if (!paneReadFailed && (!live || live.dead) && recipe && workspaceId) {
        try {
          const pane = await relaunchFromRecipe(
            this.deps.launch,
            recipe,
            workspaceId,
          );
          this.deps.store.updateRunPane(action.taskId, run.id, pane);
        } catch {
          // The next observation reports the pane's state; the message itself was delivered.
        }
      }
    }
    return {
      ...output,
      transportAttempt: {
        startedAt,
        completedAt: this.deps.now() as IsoTime,
        sessionId,
        sessionEpoch: run.sessionEpoch,
        runAttempt: run.attempts,
      },
    };
  }

  private async interrupt(
    action: Extract<Action, { kind: "interrupt_run" }>,
    state: TaskState,
  ): Promise<Record<string, never>> {
    const { adapters } = this.deps;
    const run = this.run(state, action.runId);
    if (!run.sessionId) return {};
    if (action.reason === "human requested stop") {
      const current = deriveStatus(
        run,
        await observeRun(adapters, this.deps.now(), run),
      );
      if (current.status !== "working")
        throw new PreconditionFailed(
          "Refusing to interrupt: the run is not working",
        );
    }
    if (run.provider === "codex") {
      const turnId = run.inFlightTurnId ?? run.lastTurn?.id;
      if (!turnId) return {};
      const codex = await adapters.codex(action.taskId);
      await codex.interruptTurn({ threadId: run.sessionId, turnId: turnId });
      return {};
    }
    if (run.mode === "headless")
      await adapters.claude.interruptHeadless(run.sessionId);
    else if (run.pane) await adapters.paneHost.sendKey(run.pane, "Escape");
    return {};
  }

  private async answerPanePrompt(
    action: Extract<Action, { kind: "answer_pane_prompt" }>,
    state: TaskState,
  ): Promise<Record<string, never>> {
    const { adapters } = this.deps;
    const run = this.run(state, action.runId);
    const decision = await checkPanePromptGate(adapters, this.deps.now(), run);
    if (!decision.ok)
      throw new PreconditionFailed(`Refusing to answer: ${decision.reason}`);
    if (!run.pane) throw new PreconditionFailed("The run has no pane");

    if (action.expectedDialog) {
      const observation = await observeRun(adapters, this.deps.now(), run);
      const p = observation.provider.ok ? observation.provider.value : null;
      const d = p?.provider === "claude" ? p.hooks.pendingDialog : null;
      const expected = action.expectedDialog;
      if (
        run.sessionEpoch !== expected.sessionEpoch ||
        p?.provider !== "claude" ||
        p.agentsEntry?.status !== "waiting" ||
        d?.kind !== "permission" ||
        d.requestId !== expected.requestId ||
        d.at !== expected.at ||
        d.command !== expected.command
      )
        throw new PreconditionFailed(
          "Automatic permission occurrence is no longer current",
        );
    }
    await pressPaneChoice(adapters.paneHost, run.pane, action.choice);

    return {};
  }

}
