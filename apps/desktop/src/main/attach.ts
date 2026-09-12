import type { RunId } from "@loom/core";
import type { RunTarget } from "@loom/protocol";
import { TrackerClient } from "../shared/client.js";
import type { ConnectionConfig } from "../shared/connection.js";

/** Resolve in main, from the authenticated coordinator. The renderer supplies only a run ID. */
export function resolveAttach(
  config: ConnectionConfig,
  runId: RunId,
): Promise<RunTarget> {
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
          .command({ kind: "open_attach_session", runId })
          .then((outcome) => {
            clearTimeout(timer);
            client.stop();
            if (!outcome.ok) return reject(new Error(outcome.error.message));
            if (outcome.result.kind !== "attach_session")
              return reject(new Error("Invalid attach acknowledgement"));
            const target = outcome.result.target;
            if (
              target.runId !== runId ||
              target.attach?.kind !== "pane_host" ||
              !target.pane ||
              target.pane.dead ||
              !target.pane.hostGeneration.startsWith(`loom-${config.instance}#`)
            )
              return reject(
                new Error("This run has no live pane in this instance"),
              );
            resolve(target);
          });
      },
    });
    client.start();
  });
}
