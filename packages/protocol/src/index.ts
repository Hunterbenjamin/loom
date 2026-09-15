// The coordinator to UI API. Windows hold no durable state: they connect, take a snapshot, apply
// patches, and send commands. Designed for several windows at once (docs/design/ui.md).

export * from "./briefs.js";
export * from "./commands.js";
export * from "./entities.js";
export * from "./frames.js";
export {
  approvalId,
  artifactId,
  blobOid,
  clientId,
  draftId,
  fileId,
  findingId,
  inputId,
  isoTime,
  messageId,
  providerSessionId,
  questionId,
  repoId,
  requestId,
  runId,
  sha,
  taskId,
  threadId,
  transitionId,
  worktreePath,
} from "./ids.js";
export * from "./notes.js";
export * from "./patch.js";
export * from "./pull-requests.js";
export * from "./settings.js";
export * from "./snapshot.js";
export * from "./subscriptions.js";
export * from "./views.js";
