import {
  type SettingDefinition,
  type SettingsPatch,
  type SettingsValues,
  settingValue,
} from "@loom/core";
import type { SettingsDocument } from "@loom/protocol";
import { useEffect, useMemo, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";

const sections: SettingDefinition["section"][] = [
  "Agents & models",
  "Workflow & approvals",
  "Repositories",
  "Access & safety",
  "Main",
  "Terminals & keybindings",
  "GitHub",
  "Appearance",
  "Advanced runtime",
];
const choices: Record<string, readonly string[]> = {
  provider: ["codex", "claude"],
  reasoningEffort: [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ],
  runMode: ["interactive", "headless"],
  access: ["full", "approval-gated"],
  "workflow.size": ["small", "normal"],
  "workflow.mergePolicy": ["require-human", "auto-small", "auto-all"],
  "appearance.theme": ["dark", "light", "system"],
  "appearance.windowMode": ["tracker", "workbench"],
};
const setAt = (
  target: Record<string, unknown>,
  path: string,
  value: unknown,
) => {
  const parts = path.split(".");
  let parent = target;
  for (const part of parts.slice(0, -1)) {
    const existing = parent[part];
    parent[part] = existing && typeof existing === "object" ? existing : {};
    parent = parent[part] as Record<string, unknown>;
  }
  parent[parts.at(-1) ?? ""] = value;
};
const display = (value: unknown) =>
  value === null
    ? "None"
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);
const accessHelp = (key: string, value: unknown) => {
  if (!key.endsWith(".access")) return null;
  if (key.split(".")[1] === "planner")
    return "Planner safety floor: Codex read-only; Claude edit tools disabled.";
  return value === "approval-gated"
    ? "Codex workspace-write/on-request; Claude interactive permission prompts."
    : "Codex danger-full-access/never; Claude bypass permissions.";
};

function JsonInput({
  id,
  value,
  disabled,
  onChange,
  onValidityChange,
}: {
  id: string;
  value: object;
  disabled: boolean;
  onChange(value: unknown): void;
  onValidityChange(valid: boolean): void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  useEffect(() => setText(serialized), [serialized]);
  return (
    <textarea
      id={id}
      rows={10}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        try {
          onChange(JSON.parse(next));
          onValidityChange(true);
        } catch {
          onValidityChange(false);
        }
      }}
    />
  );
}

function Control({
  definition,
  document,
  draft,
  changed,
  onChange,
  onValidityChange,
}: {
  definition: SettingDefinition;
  document: SettingsDocument;
  draft: SettingsValues;
  changed: boolean;
  onChange(value: unknown): void;
  onValidityChange(valid: boolean): void;
}) {
  const key = definition.key;
  const value = settingValue(draft, key);
  const defaultValue = settingValue(document.defaults, key);
  const source = document.sources[key] ?? "default";
  const unavailable = !definition.scopes.includes(document.scope.kind);
  const disabled =
    source === "environment" || unavailable || definition.readOnly === true;
  const tail = key.split(".").at(-1) ?? key;
  const role = key.startsWith("roles.")
    ? (key.split(".")[1] as keyof SettingsValues["roles"])
    : null;
  let options = choices[key] ?? choices[tail];
  if (tail === "model" && role)
    options =
      document.modelCatalog.providers[draft.roles[role].provider]?.models ?? [];
  const unsupportedReasoning =
    tail === "reasoningEffort" &&
    role !== null &&
    draft.roles[role].provider === "claude";
  const inputId = `setting-${key.replaceAll(".", "-")}`;
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? (
      <JsonInput
        id={inputId}
        value={value}
        disabled={disabled}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />
    ) : typeof value === "boolean" ? (
      <input
        id={inputId}
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    ) : options ? (
      <select
        id={inputId}
        value={value === null ? "" : String(value)}
        disabled={disabled || unsupportedReasoning}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {unsupportedReasoning ? (
          <option value="">Not supported by Claude</option>
        ) : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : typeof value === "number" ||
      (value === null && typeof defaultValue === "number") ? (
      <input
        id={inputId}
        type="number"
        min="1"
        value={value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    ) : Array.isArray(value) ? (
      <input
        id={inputId}
        value={value.join(", ")}
        disabled={disabled}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
      />
    ) : (
      <input
        id={inputId}
        value={value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  return (
    <div className={`setting-row${changed ? " setting-changed" : ""}`}>
      <label htmlFor={inputId}>
        <span className="setting-label">{definition.label}</span>
        {input}
      </label>
      <div className="setting-meta">
        <span className={`setting-source source-${source}`}>{source}</span>
        <span>Applies: {definition.timing.replaceAll("-", " ")}</span>
        <span>Built-in: {display(defaultValue)}</span>
        {disabled ? (
          <span>
            {source === "environment"
              ? `Overridden by ${definition.environment ?? "environment"}`
              : unavailable
                ? "Instance-wide; edit Global defaults"
                : "Read-only Loom policy"}
          </span>
        ) : null}
      </div>
      {accessHelp(key, value) ? (
        <div className="setting-help">{accessHelp(key, value)}</div>
      ) : null}
    </div>
  );
}

export function SettingsView() {
  const store = useStoreApi();
  const documents = useStore((state) => state.settings);
  const repos = useStore((state) => state.snapshot.repos);
  const selectedRepo = useStore((state) => state.ui.repo);
  const [scopeId, setScopeId] = useState(() =>
    selectedRepo ? `repo:${selectedRepo}` : "global",
  );
  const document =
    documents.find((item) => item.id === scopeId) ??
    documents.find((item) => item.id === "global") ??
    null;
  const [draft, setDraft] = useState<SettingsValues | null>(
    document?.effective ?? null,
  );
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(document ? structuredClone(document.effective) : null);
    setChanged(new Set());
    setInvalid(new Set());
  }, [document]);
  const definitions = useMemo(() => document?.catalog ?? [], [document]);
  if (!document || !draft)
    return (
      <div className="settings-page pad">
        <p>Settings are unavailable while disconnected.</p>
      </div>
    );

  const change = (key: string, value: unknown) => {
    setDraft((current) => {
      const next = structuredClone(
        current ?? document.effective,
      ) as unknown as Record<string, unknown>;
      setAt(next, key, value);
      if (key.endsWith(".provider")) {
        const role = key.split(".")[1] as keyof SettingsValues["roles"];
        const provider = value as "codex" | "claude";
        setAt(
          next,
          `roles.${role}.model`,
          document.modelCatalog.providers[provider]?.models[0] ?? "",
        );
        setAt(
          next,
          `roles.${role}.reasoningEffort`,
          provider === "codex" ? "medium" : null,
        );
        setChanged(
          (keys) =>
            new Set([
              ...keys,
              `roles.${role}.model`,
              `roles.${role}.reasoningEffort`,
            ]),
        );
      }
      return next as unknown as SettingsValues;
    });
    setChanged((keys) => new Set(keys).add(key));
    setStatus("");
  };
  const save = async (section: SettingDefinition["section"]) => {
    const fields = definitions.filter(
      (item) => item.section === section && changed.has(item.key),
    );
    if (!fields.length) return;
    const patch: Record<string, unknown> = {};
    for (const item of fields)
      setAt(patch, item.key, settingValue(draft, item.key));
    setBusy(true);
    const outcome = await store.command({
      kind: "update_settings",
      scope: document.scope,
      expectedVersion: document.version,
      patch: patch as SettingsPatch,
    });
    setBusy(false);
    setStatus(
      outcome.ok
        ? `${section} saved.${fields.some((item) => item.timing === "restart-required") ? " Restart Loom for labeled changes." : ""}`
        : `${outcome.error.message}${outcome.error.details.length ? `: ${outcome.error.details.join("; ")}` : ""}`,
    );
  };
  const reset = async (section: SettingDefinition["section"]) => {
    const keys = definitions
      .filter(
        (item) =>
          item.section === section &&
          settingValue(document.stored, item.key) !== undefined,
      )
      .map((item) => item.key);
    if (!keys.length) return;
    setBusy(true);
    const outcome = await store.command({
      kind: "reset_settings",
      scope: document.scope,
      expectedVersion: document.version,
      keys,
    });
    setBusy(false);
    setStatus(
      outcome.ok
        ? `${section} reset to ${document.scope.kind === "global" ? "built-in defaults" : "inherited values"}.`
        : outcome.error.message,
    );
  };

  return (
    <main className="settings-page" aria-labelledby="settings-heading">
      <div className="settings-intro">
        <div>
          <h2 id="settings-heading">Loom settings</h2>
          <p>
            New tasks and runs capture defaults. Active runs keep their launch
            recipe.
          </p>
        </div>
        <label>
          Scope
          <select
            value={document.id}
            onChange={(e) => {
              setScopeId(e.target.value);
              setStatus("");
            }}
          >
            <option value="global">Global defaults</option>
            {repos.map((repo) => (
              <option key={repo.id} value={`repo:${repo.id}`}>
                {repo.github}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section
        className="credential-readiness"
        aria-label="Credential readiness"
      >
        <span>
          Codex:{" "}
          {document.credentialReadiness.codex ? "configured" : "not detected"}
        </span>
        <span>
          Claude:{" "}
          {document.credentialReadiness.claude ? "configured" : "not detected"}
        </span>
        <span>
          GitHub:{" "}
          {document.credentialReadiness.github ? "configured" : "not detected"}
        </span>
      </section>
      {status ? (
        <div className="settings-status" role="status" aria-live="polite">
          {status}
        </div>
      ) : null}
      {sections.map((section) => {
        const fields = definitions.filter((item) => item.section === section);
        const dirty = fields.some((item) => changed.has(item.key));
        const hasInvalid = fields.some((item) => invalid.has(item.key));
        const resettable = fields.some(
          (item) => settingValue(document.stored, item.key) !== undefined,
        );
        return (
          <section className="settings-section" key={section}>
            <header>
              <h3>{section}</h3>
              <div className="settings-actions">
                <button
                  type="button"
                  disabled={busy || !resettable}
                  onClick={() => void reset(section)}
                >
                  Reset{" "}
                  {document.scope.kind === "global"
                    ? "defaults"
                    : "to inherited"}
                </button>
                <button
                  type="button"
                  disabled={busy || !dirty || hasInvalid}
                  onClick={() => void save(section)}
                >
                  Save
                </button>
              </div>
            </header>
            {fields.map((field) => (
              <Control
                key={field.key}
                definition={field}
                document={document}
                draft={draft}
                changed={changed.has(field.key)}
                onChange={(value) => change(field.key, value)}
                onValidityChange={(valid) =>
                  setInvalid((keys) => {
                    const next = new Set(keys);
                    if (valid) next.delete(field.key);
                    else next.add(field.key);
                    return next;
                  })
                }
              />
            ))}
          </section>
        );
      })}
      <section className="settings-section settings-audit">
        <h3>Recent changes</h3>
        {document.audit.length ? (
          <ol>
            {document.audit.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <code>{entry.settingKey}</code> changed by {entry.actor}{" "}
                <time>{new Date(entry.changedAt).toLocaleString()}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="faint">No changes recorded for this scope.</p>
        )}
      </section>
    </main>
  );
}
