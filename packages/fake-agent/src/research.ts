import type { ResearchSession } from "@loom/protocol";

export const fakeResearchDocument = {
  title: "Keybindings and context",
  body: "## Findings\n\nModes change how a key is interpreted.\n\nChoose bindings that remain discoverable. [Source](https://example.invalid/keybindings)",
  sources: [
    {
      title: "Keybinding documentation",
      url: "https://example.invalid/keybindings",
    },
  ],
};
export const fakeResearchSession: ResearchSession = async (request) => {
  request.onSession(request.sessionId);
  request.controller.signal.throwIfAborted();
  return structuredClone(fakeResearchDocument);
};
