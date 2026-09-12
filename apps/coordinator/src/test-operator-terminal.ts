import type { ProviderSessionId } from "@loom/core";
import type { FakePaneHost, FakeProviders } from "@loom/fake-agent";

/** Native interactive observations for Operator tests; no real CLI or pane process. */
export function wireOperatorTerminal(
  host: FakePaneHost,
  providers: FakeProviders,
) {
  let sessionId: ProviderSessionId | null = null;
  const launch = host.ensurePane;
  host.ensurePane = async (req) => {
    if (req.runId === "operator") {
      const flag = req.args.includes("--resume") ? "--resume" : "--session-id";
      sessionId = req.args[req.args.indexOf(flag) + 1] as ProviderSessionId;
      if (!providers.sessions.has(sessionId))
        providers.create("claude", req.cwd, sessionId, "interactive");
      else {
        const value = providers.get(sessionId).value;
        if (value.provider === "claude" && !value.agentsEntry)
          providers.recover(sessionId);
      }
    }
    return launch(req);
  };
  const paste = host.pasteText;
  host.pasteText = async (ref, text) => {
    const result = await paste(ref, text);
    if (ref.sessionName === "loom-operator" && sessionId) {
      providers.enqueue(sessionId, text);
      providers.confirm(sessionId);
    }
    return result;
  };
  const close = host.closePane;
  host.closePane = async (ref) => {
    await close(ref);
    if (ref.sessionName === "loom-operator" && sessionId)
      providers.crash(sessionId);
  };
}
