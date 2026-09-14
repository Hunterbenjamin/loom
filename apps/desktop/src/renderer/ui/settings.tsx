import { type SettingsValues, settingValue } from "@loom/core";
import type { SettingsDocument } from "@loom/protocol";
import { useState } from "react";
import { useStore } from "../store/react.js";
import {
  type FieldContext,
  Group,
  Row,
  Segmented,
  Select,
  TextInput,
  Toggle,
  useField,
  useSettingsWriter,
} from "./settings-fields.js";
import { KeyboardSettings } from "./settings-keys.js";

type Role = keyof SettingsValues["roles"];
const ROLES: Role[] = ["planner", "implementer", "reviewer"];

const SECTIONS = [
  { id: "general", label: "General", scoped: false },
  { id: "agents", label: "Agents", scoped: true },
  { id: "workflow", label: "Workflow", scoped: true },
  { id: "keyboard", label: "Keyboard", scoped: false },
  { id: "advanced", label: "Advanced", scoped: false },
  { id: "history", label: "History", scoped: false },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const MERGE_LABELS: Record<string, string> = {
  "require-human": "Always ask me",
  "auto-small": "Auto-merge small issues",
  "auto-all": "Auto-merge everything",
};
const ACCESS_LABELS: Record<string, string> = {
  full: "Full access",
  "approval-gated": "Ask before acting",
};
const RUNTIME_LABELS: Record<string, [string, string]> = {
  capTotal: ["Concurrent agents", "Most agents running at once."],
  capCodex: ["Concurrent Codex agents", "Most Codex agents running at once."],
  capClaude: [
    "Concurrent Claude agents",
    "Most Claude agents running at once.",
  ],
  retryBaseMs: ["Retry delay", "First wait before retrying a failed run."],
  retryCapMs: ["Longest retry delay", "Retry waits never grow past this."],
  retryMaxAttempts: ["Retry attempts", "Retries before a run needs you."],
  stallAfterMs: ["Stall after", "Quiet time before a run counts as stalled."],
  fixRoundStallAfterMs: [
    "Fix round stall after",
    "Quiet time before a fix round counts as stalled.",
  ],
  unknownGraceMs: [
    "Unknown status grace",
    "How long a run may report no status.",
  ],
  deliveryTimeoutMs: [
    "Message delivery timeout",
    "Wait for an agent to confirm a message.",
  ],
  githubPollMs: ["GitHub poll interval", "How often GitHub is re-read."],
  resyncMs: ["Resync interval", "How often all state is re-read."],
  heartbeatMs: ["Heartbeat", "Coordinator liveness interval."],
  worktreeRoot: ["Worktree folder", "Where issue worktrees are created."],
  tmuxExecutable: ["tmux", "Path to the tmux executable."],
  codexExecutable: ["Codex", "Path to the Codex executable."],
  claudeExecutable: ["Claude", "Path to the Claude executable."],
};

const duration = (ms: number) =>
  ms % 60_000 === 0
    ? `${ms / 60_000} min`
    : ms % 1000 === 0
      ? `${ms / 1000} s`
      : `${ms} ms`;

function General({ context }: { context: FieldContext }) {
  const theme = useField(context, "appearance.theme");
  const chime = useField(context, "appearance.chime");
  const windowMode = useField(context, "appearance.windowMode");
  const excluded = useField(context, "runtime.excludedAuthors");
  return (
    <>
      <Group title="Appearance">
        <Row field={theme} label="Theme">
          <Segmented
            field={theme}
            options={[
              ["dark", "Dark"],
              ["light", "Light"],
              ["system", "System"],
            ]}
          />
        </Row>
        <Row
          field={chime}
          label="Completion chime"
          description="Play a sound when an agent finishes a turn."
        >
          <Toggle field={chime} label="Completion chime" />
        </Row>
        <Row
          field={windowMode}
          label="Open in"
          description="The window Loom shows when it starts."
        >
          <Segmented
            field={windowMode}
            options={[
              ["tracker", "Tracker"],
              ["workbench", "Workbench"],
            ]}
          />
        </Row>
      </Group>
      <Group title="GitHub">
        <Row
          field={excluded}
          label="Hide pull requests from"
          description="GitHub usernames, separated by commas."
          wide
        >
          <TextInput field={excluded} kind="list" placeholder="None" />
        </Row>
      </Group>
    </>
  );
}

function RoleCell({
  context,
  role,
  setting,
}: {
  context: FieldContext;
  role: Role;
  setting: "provider" | "model" | "reasoningEffort" | "runMode";
}) {
  const field = useField(context, `roles.${role}.${setting}`);
  const roles = context.writer.pending;
  const provider = (roles[`roles.${role}.provider`] ??
    field.document.effective.roles[role].provider) as "codex" | "claude";
  const catalog = field.document.modelCatalog.providers[provider];
  if (setting === "provider")
    return (
      <Select
        field={{
          ...field,
          save: (value) => {
            const next = value as "codex" | "claude";
            field.save(value, {
              [`roles.${role}.model`]:
                field.document.modelCatalog.providers[next]?.models[0] ?? "",
              [`roles.${role}.reasoningEffort`]:
                next === "codex" ? "medium" : null,
            });
          },
        }}
        options={["codex", "claude"]}
        labels={{ codex: "Codex", claude: "Claude" }}
      />
    );
  if (setting === "model")
    return <Select field={field} options={catalog?.models ?? []} />;
  if (setting === "reasoningEffort")
    return provider === "claude" ? (
      <span className="settings-muted" title="Claude has no reasoning setting">
        —
      </span>
    ) : (
      <Select field={field} options={catalog?.reasoning ?? []} />
    );
  return (
    <Select
      field={field}
      options={["interactive", "headless"]}
      labels={{ interactive: "Interactive", headless: "Headless" }}
    />
  );
}

function RoleReset({ context, role }: { context: FieldContext; role: Role }) {
  const keys = ["provider", "model", "reasoningEffort", "runMode"].map(
    (setting) => `roles.${role}.${setting}`,
  );
  const stored = keys.filter(
    (key) => settingValue(context.document.stored, key) !== undefined,
  );
  if (!stored.length) return null;
  const repository = context.document.scope.kind === "repository";
  return (
    <button
      type="button"
      className="settings-reset"
      onClick={() => context.writer.reset(context.document, stored)}
    >
      {repository ? "Use default" : "Reset"}
    </button>
  );
}

function Agents({ context }: { context: FieldContext }) {
  const main = useField(context, "main.model");
  const roleErrors = ROLES.flatMap((role) =>
    ["provider", "model", "reasoningEffort", "runMode"]
      .map((setting) => context.writer.errors[`roles.${role}.${setting}`])
      .filter(Boolean),
  );
  return (
    <>
      <Group
        title="Pipeline agents"
        description="Which agent runs each stage of an issue. Changes apply to the next run."
      >
        <div className="settings-table-wrap">
          <table className="settings-roles">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Reasoning</th>
                <th>Run mode</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role}>
                  <th scope="row">
                    {role[0]?.toUpperCase()}
                    {role.slice(1)}
                    {context.document.scope.kind === "repository" &&
                    ["provider", "model", "reasoningEffort", "runMode"].some(
                      (setting) =>
                        context.document.sources[`roles.${role}.${setting}`] ===
                        "repository",
                    ) ? (
                      <span className="settings-badge accent">
                        This repository
                      </span>
                    ) : null}
                  </th>
                  {(
                    ["provider", "model", "reasoningEffort", "runMode"] as const
                  ).map((setting) => (
                    <td key={setting}>
                      <RoleCell
                        context={context}
                        role={role}
                        setting={setting}
                      />
                    </td>
                  ))}
                  <td className="settings-roles-reset">
                    <RoleReset context={context} role={role} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {roleErrors.length ? (
          <div className="settings-row-error settings-table-error" role="alert">
            {roleErrors.join(" ")}
          </div>
        ) : null}
      </Group>
      <Group title="Access" description="What each agent may do on its own.">
        {ROLES.map((role) => (
          <AccessRow key={role} context={context} role={role} />
        ))}
      </Group>
      <Group title="Main">
        <Row
          field={main}
          label="Main model"
          description="The Claude model your Main agent runs on."
        >
          <Select
            field={main}
            options={context.global.modelCatalog.providers.claude?.models ?? []}
            empty="Claude default"
          />
        </Row>
      </Group>
    </>
  );
}

function AccessRow({ context, role }: { context: FieldContext; role: Role }) {
  const field = useField(context, `roles.${role}.access`);
  const description =
    role === "planner"
      ? "Planners are always read-only: Codex runs read-only and Claude has edit tools turned off."
      : field.value === "approval-gated"
        ? "Codex asks before writing outside the workspace; Claude shows permission prompts."
        : "Codex and Claude run without permission prompts.";
  return (
    <Row
      field={field}
      label={`${role[0]?.toUpperCase()}${role.slice(1)}`}
      description={description}
    >
      <Select
        field={field}
        options={["full", "approval-gated"]}
        labels={ACCESS_LABELS}
      />
    </Row>
  );
}

function Workflow({ context }: { context: FieldContext }) {
  const approval = useField(context, "workflow.requirePlanApproval");
  const size = useField(context, "workflow.size");
  const budget = useField(context, "workflow.budgetMinutes");
  const rounds = useField(context, "workflow.reviewRoundCap");
  const merge = useField(context, "workflow.mergePolicy");
  const base = useField(context, "repository.baseBranch");
  const serial = useField(context, "repository.serialTests");
  return (
    <>
      <Group
        title="Issues"
        description="Defaults for new issues. Existing issues keep what they started with."
      >
        <Row
          field={approval}
          label="Require plan approval"
          description="Wait for your approval before an agent implements a plan."
        >
          <Toggle field={approval} label="Require plan approval" />
        </Row>
        <Row field={size} label="Default size">
          <Segmented
            field={size}
            options={[
              ["small", "Small"],
              ["normal", "Normal"],
            ]}
          />
        </Row>
        <Row
          field={budget}
          label="Time budget"
          description="Leave empty for no budget."
        >
          <TextInput
            field={budget}
            kind="number"
            placeholder="None"
            suffix="min"
          />
        </Row>
        <Row
          field={rounds}
          label="Review rounds"
          description="Most review rounds before an issue needs you."
        >
          <TextInput field={rounds} kind="number" />
        </Row>
        <Row
          field={merge}
          label="Merging"
          description="What happens once an issue passes review and CI."
        >
          <Select
            field={merge}
            options={["require-human", "auto-small", "auto-all"]}
            labels={MERGE_LABELS}
          />
        </Row>
      </Group>
      <Group title="Repository">
        <Row
          field={base}
          label="Base branch"
          description="New worktrees start here and pull requests target it."
        >
          <TextInput field={base} />
        </Row>
        <Row
          field={serial}
          label="Run tests one at a time"
          description="Serialize test runs across issues."
        >
          <Toggle field={serial} label="Run tests one at a time" />
        </Row>
      </Group>
    </>
  );
}

function Advanced({ context }: { context: FieldContext }) {
  const keys = context.global.catalog
    .filter((item) => item.section === "Advanced runtime")
    .map((item) => item.key);
  return (
    <Group
      title="Runtime"
      description="Coordinator limits and timings. The defaults suit most machines."
    >
      {keys.map((key) => (
        <RuntimeRow key={key} context={context} settingKey={key} />
      ))}
    </Group>
  );
}

function RuntimeRow({
  context,
  settingKey,
}: {
  context: FieldContext;
  settingKey: string;
}) {
  const field = useField(context, settingKey);
  const name = settingKey.split(".").at(-1) ?? settingKey;
  const [label, description] = RUNTIME_LABELS[name] ?? [name, ""];
  const ms = name.endsWith("Ms");
  const numeric = typeof field.value === "number";
  return (
    <Row
      field={field}
      label={label}
      description={
        ms && numeric
          ? `${description} Currently ${duration(field.value as number)}.`
          : description
      }
    >
      <TextInput
        field={field}
        kind={numeric ? "number" : "text"}
        suffix={ms ? "ms" : undefined}
      />
    </Row>
  );
}

function History({ document }: { document: SettingsDocument }) {
  return (
    <Group title="Recent changes">
      {document.audit.length ? (
        document.audit.slice(0, 30).map((entry) => (
          <div className="settings-row" key={entry.id}>
            <div className="settings-row-text">
              <div className="settings-row-label">
                <code>{entry.settingKey}</code>
              </div>
              <div className="settings-row-description">
                Changed by {entry.actor}
              </div>
            </div>
            <time className="settings-muted">
              {new Date(entry.changedAt).toLocaleString()}
            </time>
          </div>
        ))
      ) : (
        <div className="settings-row settings-muted">
          No changes recorded yet.
        </div>
      )}
    </Group>
  );
}

export function SettingsView() {
  const documents = useStore((state) => state.settings);
  const repos = useStore((state) => state.snapshot.repos);
  const selectedRepo = useStore((state) => state.ui.repo);
  const [section, setSection] = useState<SectionId>("general");
  const [scopeId, setScopeId] = useState("global");
  const writer = useSettingsWriter();
  const global = documents.find((item) => item.id === "global") ?? null;
  const meta = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
  if (!global)
    return (
      <div className="settings-page pad">
        <p className="settings-muted">
          Settings are unavailable while disconnected.
        </p>
      </div>
    );
  const scoped =
    (meta.scoped &&
      documents.find((item) => item.id === scopeId && item.id !== "global")) ||
    global;
  const context: FieldContext = { document: scoped, global, writer };
  const scopeRepos = [
    ...repos.filter((repo) => repo.id === selectedRepo),
    ...repos.filter((repo) => repo.id !== selectedRepo),
  ].filter((repo) => documents.some((item) => item.id === `repo:${repo.id}`));

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="settings-nav-item"
            aria-current={item.id === section ? "page" : undefined}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main className="settings-content" aria-labelledby="settings-heading">
        <header className="settings-header">
          <div>
            <h2 id="settings-heading">{meta.label}</h2>
            {meta.scoped ? (
              <p>
                {scoped.scope.kind === "repository"
                  ? "Overrides for this repository. Anything not overridden uses the default for all repositories."
                  : "Defaults for every repository."}
              </p>
            ) : null}
          </div>
          {meta.scoped && scopeRepos.length ? (
            <fieldset className="segmented settings-scope" aria-label="Scope">
              <button
                type="button"
                className="settings-segment"
                aria-pressed={scoped.id === "global"}
                onClick={() => setScopeId("global")}
              >
                All repositories
              </button>
              {scopeRepos.map((repo) => (
                <button
                  key={repo.id}
                  type="button"
                  className="settings-segment"
                  aria-pressed={scoped.id === `repo:${repo.id}`}
                  onClick={() => setScopeId(`repo:${repo.id}`)}
                >
                  {repo.github}
                </button>
              ))}
            </fieldset>
          ) : null}
        </header>
        {section === "general" ? <General context={context} /> : null}
        {section === "agents" ? <Agents context={context} /> : null}
        {section === "workflow" ? <Workflow context={context} /> : null}
        {section === "keyboard" ? <KeyboardSettings context={context} /> : null}
        {section === "integrations" ? <Integrations context={context} /> : null}
        {section === "advanced" ? <Advanced context={context} /> : null}
        {section === "history" ? <History document={global} /> : null}
      </main>
    </div>
  );
}
