// Routes task-run and repository Main tokens to their existing MCP hosts.
import {
  displayName,
  type IsoTime,
  issueKey,
  type Repo,
  type RepoId,
  resolveTaskRef,
  type TaskId,
} from "@loom/core";
import { leadCommand } from "@loom/mcp";
import { inspectTask } from "./inspect.js";
import type { LeadSession } from "./lead.js";
import { messageAgent } from "./main-messages.js";
import { createMcpHost, type McpHostDeps } from "./mcp-host.js";

interface AgentMcpDeps extends McpHostDeps {
  research: import("./research.js").Research;
  leads: Map<string, LeadSession>;
  leadFor(repoId: string): LeadSession;
  repoById(repoId: RepoId): Repo;
  now(): IsoTime;
  log(message: string): void;
  reportAdapterFailure(operation: string, error: unknown): void;
  command(value: unknown): Promise<unknown>;
}

export function createAgentMcp(deps: AgentMcpDeps) {
  const { host, resolveToken, buildAnchor } = createMcpHost({
    store: deps.store,
    adapters: deps.adapters,
    recipes: deps.recipes,
    loop: deps.loop,
    workflow: deps.workflow,
    repo: (taskId) => deps.repo(taskId),
    log: (message) => deps.log(message),
    reportAdapterFailure: (operation, error) =>
      deps.reportAdapterFailure(operation, error),
  });
  return {
    host,
    buildAnchor,
    log: (message: string) => deps.log(`MCP: ${message}`),
    researchHost: {
      read: (id: string, path: string, offset: number, list: boolean) =>
        deps.research.readScope(id, path, offset, list),
      submit: (
        id: string,
        document: import("@loom/protocol").ResearchDocument,
      ) => deps.research.submit(id, document),
    },
    resolveToken: (token: string) =>
      deps.research.resolve(token) ??
      [...deps.leads.values()]
        .map((lead) => lead.resolve(token))
        .find(Boolean) ??
      resolveToken(token),
    leadHost: {
      invoke: async (
        name: string,
        input: Record<string, unknown>,
        repoId?: string,
      ) => {
        if (!repoId) throw new Error("Main repository identity is required");
        const lead = deps.leadFor(repoId);
        const tasks = deps.store.tasks();
        const repos = deps.store.repos();
        const resolveLeadRef = (reference: string) => {
          const result = resolveTaskRef(reference, { tasks, repos, repoId });
          if (!result.ok) throw new Error(result.message);
          return result.task.id;
        };
        if (name === "message_agent") {
          if (
            typeof input.to === "object" &&
            input.to !== null &&
            "taskId" in input.to &&
            typeof input.to.taskId === "string"
          ) {
            const result = resolveTaskRef(input.to.taskId, {
              tasks,
              repos,
              repoId,
            });
            if (!result.ok)
              return { delivered: "refused", reason: result.message };
            input = {
              ...input,
              to: { ...input.to, taskId: result.task.id },
            };
          }
          return messageAgent(
            {
              store: deps.store,
              adapters: deps.adapters,
              now: () => deps.now(),
              enqueue: (taskId) => deps.loop.enqueue(taskId),
            },
            repoId,
            input,
          );
        }
        if (name === "set_note") return lead.setNote(input.note as string);
        if (name === "list_tasks") {
          const repo = deps.repoById(repoId as RepoId);
          return tasks
            .filter((task) => task.repoId === repoId)
            .map((task) => ({
              ...task,
              issue: issueKey(repo, task),
              displayName: displayName(task),
            }));
        }
        if (name === "list_repos")
          return deps.store.repos().filter((repo) => repo.id === repoId);
        if (typeof input.taskId === "string")
          input = { ...input, taskId: resolveLeadRef(input.taskId) };
        if (input.repoId && input.repoId !== repoId)
          throw new Error("Repository is outside Main's scope");
        if (name === "create_task") input = { ...input, repoId };
        if (Array.isArray(input.blockedBy))
          input = {
            ...input,
            blockedBy: input.blockedBy.map((value) =>
              resolveLeadRef(String(value)),
            ),
          };
        if (name === "inspect_task")
          return inspectTask(deps.store, input.taskId as TaskId, deps.adapters);
        if (name === "comment_research") {
          const command = leadCommand(name, input);
          if (command.kind !== "comment_research")
            throw new Error("Invalid research command");
          const entry = await deps.research.comment(
            command.id,
            command.message,
            "main",
          );
          return {
            ok: true,
            result: {
              kind: "research_entry",
              entry,
              comments: deps.store.research.comments(entry.id),
            },
          };
        }
        return deps.command(leadCommand(name, input));
      },
    },
  };
}
