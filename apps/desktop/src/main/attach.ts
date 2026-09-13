import type { RunId } from "@loom/core";
import type {
  LeadTarget,
  PaneAttachTarget,
  PaneIdentity,
  RunTarget,
} from "@loom/protocol";
import { repoId } from "@loom/protocol";
import { TrackerClient } from "../shared/client.js";
import type { ConnectionConfig } from "../shared/connection.js";

/** Resolve in main, from the authenticated coordinator. The renderer supplies only a logical target identity. */
export function resolveAttach(
  config: ConnectionConfig,
  runId:
    | RunId
    | { lead: string }
    | PaneIdentity
    | { shellKey: string; shellName?: string },
): Promise<RunTarget | LeadTarget | PaneAttachTarget> {
  if (config.mode !== "live")
    return Promise.reject(new Error("No coordinator configured"));
  return new Promise((resolve, reject) => {
    let requested = false;
    const timer = setTimeout(() => {
      client.stop();
      reject(new Error("Coordinator attach request timed out"));
    }, 15_000);
    const client = new TrackerClient({
      ...config,
      clientId: `attach-${crypto.randomUUID()}`,
      onState() {},
      onStatus(status) {
        if (status !== "connected" || requested) return;
        requested = true;
        void client
          .command(
            typeof runId === "object"
              ? "lead" in runId
                ? {
                    kind: "open_lead_session",
                    repoId: repoId.parse(runId.lead),
                  }
                : "shellKey" in runId
                  ? {
                      kind: "open_workbench_terminal",
                      key: runId.shellKey,
                      label: runId.shellName,
                    }
                  : { kind: "open_pane_session", target: runId }
              : { kind: "open_attach_session", runId },
          )
          .then((outcome) => {
            clearTimeout(timer);
            client.stop();
            if (!outcome.ok) return reject(new Error(outcome.error.message));
            if (outcome.result.kind !== "attach_session")
              return reject(new Error("Invalid attach acknowledgement"));
            const target = outcome.result.target;
            if (
              (typeof runId === "object"
                ? "lead" in runId
                  ? !("identity" in target) ||
                    target.identity !== "lead" ||
                    target.repoId !== runId.lead ||
                    !target.sessionId
                  : "shellKey" in runId
                    ? !("identity" in target) || target.identity !== "pane"
                    : !("identity" in target) ||
                      target.identity !== "pane" ||
                      target.target.hostGeneration !== runId.hostGeneration ||
                      target.target.windowId !== runId.windowId ||
                      target.target.paneId !== runId.paneId ||
                      target.pane.hostGeneration !== runId.hostGeneration ||
                      target.pane.windowId !== runId.windowId ||
                      target.pane.paneId !== runId.paneId
                : !("runId" in target) || target.runId !== runId) ||
              target.attach?.kind !== "pane_host" ||
              !target.pane ||
              target.pane.dead ||
              !target.pane.hostGeneration.startsWith(`loom-${config.instance}#`)
            )
              return reject(
                new Error("This run has no live pane in this instance"),
              );
            resolve(target);
          })
          .catch((error) => {
            clearTimeout(timer);
            client.stop();
            reject(error);
          });
      },
    });
    client.start();
  });
}
