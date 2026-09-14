import {
  type SettingDefinition,
  type SettingsPatch,
  settingValue,
} from "@loom/core";
import type { Command, SettingsDocument } from "@loom/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStoreApi } from "../store/react.js";

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
const patchOf = (values: Record<string, unknown>) => {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) setAt(patch, key, value);
  return patch as SettingsPatch;
};
/** Writes one change at a time, each pinned to the newest version this window has seen. */
export function useSettingsWriter() {
  const store = useStoreApi();
  const queue = useRef<Promise<void>>(Promise.resolve());
  const acked = useRef(new Map<string, number>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const run = (
    document: SettingsDocument,
    errorKey: string,
    command: (version: number) => Command,
    onDone?: () => void,
  ) => {
    queue.current = queue.current.then(async () => {
      const latest =
        store.getState().settings.find((item) => item.id === document.id) ??
        document;
      const version = Math.max(
        latest.version,
        acked.current.get(document.id) ?? 0,
      );
      const outcome = await store.command(command(version));
      if (outcome.ok && "version" in outcome.result)
        acked.current.set(document.id, outcome.result.version as number);
      setErrors((current) => {
        const next = { ...current };
        if (outcome.ok) delete next[errorKey];
        else
          next[errorKey] =
            `${outcome.error.message}${outcome.error.details.length ? `: ${outcome.error.details.join("; ")}` : ""}`;
        return next;
      });
      onDone?.();
    });
  };
  return {
    errors,
    pending,
    save(
      document: SettingsDocument,
      values: Record<string, unknown>,
      catalog: SettingDefinition[],
    ) {
      const keys = Object.keys(values);
      const errorKey = keys[0] ?? "";
      setPending((current) => ({ ...current, ...values }));
      run(
        document,
        errorKey,
        (expectedVersion) => ({
          kind: "update_settings",
          scope: document.scope,
          expectedVersion,
          patch: patchOf(values),
        }),
        () => {
          setPending((current) => {
            const next = { ...current };
            for (const key of keys) delete next[key];
            return next;
          });
          if (
            catalog.some(
              (item) =>
                keys.includes(item.key) && item.timing === "restart-required",
            )
          )
            store.toast("Saved. Restart Loom to apply it.");
        },
      );
    },
    reset(document: SettingsDocument, keys: string[]) {
      run(document, keys[0] ?? "", (expectedVersion) => ({
        kind: "reset_settings",
        scope: document.scope,
        expectedVersion,
        keys,
      }));
    },
  };
}
export type Writer = ReturnType<typeof useSettingsWriter>;

export interface FieldContext {
  document: SettingsDocument;
  global: SettingsDocument;
  writer: Writer;
}

export function useField(context: FieldContext, key: string) {
  const definition = context.document.catalog.find((item) => item.key === key);
  const available =
    !definition || definition.scopes.includes(context.document.scope.kind);
  const document = available ? context.document : context.global;
  const source = document.sources[key] ?? "default";
  const stored = settingValue(document.stored, key) !== undefined;
  const value =
    key in context.writer.pending
      ? context.writer.pending[key]
      : settingValue(document.effective, key);
  const locked =
    source === "environment"
      ? `Set by ${definition?.environment ?? "the environment"}`
      : !available
        ? "Set for all repositories"
        : definition?.readOnly
          ? "Loom policy"
          : null;
  return {
    key,
    value,
    definition,
    document,
    source,
    locked,
    overridden:
      context.document.scope.kind === "repository" && available
        ? source === "repository"
        : false,
    canReset: stored && !locked,
    error: context.writer.errors[key],
    save: (value: unknown, extra: Record<string, unknown> = {}) =>
      context.writer.save(
        document,
        { [key]: value, ...extra },
        document.catalog,
      ),
    reset: (keys: string[] = [key]) => context.writer.reset(document, keys),
  };
}
export type Field = ReturnType<typeof useField>;

export function Row({
  field,
  label,
  description,
  children,
  wide,
}: {
  field?: Field;
  label: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const repository = field?.document.scope.kind === "repository";
  return (
    <div className={`settings-row${wide ? " wide" : ""}`}>
      <div className="settings-row-text">
        <div className="settings-row-label">
          {label}
          {field?.overridden ? (
            <span className="settings-badge accent">This repository</span>
          ) : null}
          {field?.definition?.timing === "restart-required" ? (
            <span className="settings-badge">Restart required</span>
          ) : null}
        </div>
        {description ? (
          <div className="settings-row-description">{description}</div>
        ) : null}
        {field?.locked ? (
          <div className="settings-row-description">{field.locked}</div>
        ) : null}
        {field?.error ? (
          <div className="settings-row-error" role="alert">
            {field.error}
          </div>
        ) : null}
      </div>
      <div className="settings-row-control">
        {children}
        {field ? (
          // Always takes its space, so controls line up whether or not a row can reset.
          <button
            type="button"
            className={`settings-reset${field.canReset ? "" : " placeholder"}`}
            aria-hidden={!field.canReset}
            tabIndex={field.canReset ? undefined : -1}
            disabled={!field.canReset}
            title={
              repository ? "Use the value for all repositories" : "Use default"
            }
            onClick={() => field.reset()}
          >
            {repository ? "Use default" : "Reset"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Select({
  field,
  options,
  labels = {},
  empty,
  disabled,
}: {
  field: Field;
  options: readonly string[];
  labels?: Record<string, string>;
  empty?: string;
  disabled?: boolean;
}) {
  const id = `setting-${field.key.replaceAll(".", "-")}`;
  return (
    <select
      id={id}
      className="settings-select"
      value={field.value === null ? "" : String(field.value)}
      disabled={!!field.locked || disabled}
      onChange={(event) => field.save(event.target.value || null)}
    >
      {empty !== undefined ? <option value="">{empty}</option> : null}
      {options.map((option) => (
        <option key={option} value={option}>
          {labels[option] ?? option}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ field, label }: { field: Field; label: string }) {
  return (
    <input
      id={`setting-${field.key.replaceAll(".", "-")}`}
      type="checkbox"
      role="switch"
      aria-checked={field.value === true}
      aria-label={label}
      className="settings-switch"
      checked={field.value === true}
      disabled={!!field.locked}
      onChange={(event) => field.save(event.target.checked)}
    />
  );
}

export function Segmented({
  field,
  options,
}: {
  field: Field;
  options: [string, string][];
}) {
  return (
    <div className="segmented settings-segmented">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className="settings-segment"
          aria-pressed={field.value === value}
          disabled={!!field.locked}
          onClick={() => field.value !== value && field.save(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Text-like inputs save on Enter or blur; Escape puts the saved value back. */
export function TextInput({
  field,
  kind = "text",
  placeholder,
  suffix,
}: {
  field: Field;
  kind?: "text" | "number" | "list";
  placeholder?: string;
  suffix?: string;
}) {
  const shown = (value: unknown) =>
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  const [text, setText] = useState(shown(field.value));
  const saved = shown(field.value);
  useEffect(() => setText(saved), [saved]);
  const commit = () => {
    if (text === saved) return;
    const trimmed = text.trim();
    field.save(
      kind === "number"
        ? trimmed === ""
          ? null
          : Number(trimmed)
        : kind === "list"
          ? trimmed
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : trimmed || null,
    );
  };
  return (
    <span className="settings-input">
      <input
        id={`setting-${field.key.replaceAll(".", "-")}`}
        className="settings-text"
        type={kind === "number" ? "number" : "text"}
        min={kind === "number" ? 1 : undefined}
        value={text}
        placeholder={placeholder}
        disabled={!!field.locked}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setText(saved);
        }}
      />
      {kind === "number" ? (
        <span className="settings-input-suffix">{suffix}</span>
      ) : null}
    </span>
  );
}

export function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="settings-card">{children}</div>
    </section>
  );
}
