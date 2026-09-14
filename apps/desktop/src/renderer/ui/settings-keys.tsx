import { useEffect, useState } from "react";
import {
  type Action,
  actions,
  bindingChord,
  defaultKeybindings,
  isPrefixBinding,
  keybindingsConfig,
  matchesChord,
  parseChord,
} from "../../shared/keybindings.js";
import {
  type FieldContext,
  Group,
  Row,
  TextInput,
  useField,
} from "./settings-fields.js";

const GROUPS: { title: string; actions: Action[] }[] = [
  {
    title: "Panels",
    actions: [
      "split-right",
      "split-down",
      "left",
      "down",
      "up",
      "right",
      "zoom",
      "close",
    ],
  },
  {
    title: "Tabs",
    actions: [
      "new",
      "next",
      "previous",
      ...Array.from({ length: 9 }, (_, i) => `tab-${i + 1}` as Action),
    ],
  },
  {
    title: "Spaces",
    actions: [
      "new-space",
      "close-space",
      ...Array.from({ length: 9 }, (_, i) => `space-${i + 1}` as Action),
    ],
  },
  {
    title: "Agents",
    actions: [
      "jump",
      ...Array.from({ length: 9 }, (_, i) => `agent-${i + 1}` as Action),
    ],
  },
  { title: "App", actions: ["commands", "help", "literal"] },
];
const LABELS = new Map<string, string>(actions.map((a) => [a.id, a.label]));
const SYMBOLS: Record<string, string> = {
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Backspace: "⌫",
  Escape: "Esc",
  Plus: "+",
};
const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "CapsLock"]);

/** The binding string for a key press, or null for keys a binding can't name. */
export function chordFromEvent(event: KeyboardEvent): string | null {
  let key = event.key;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code) && !event.shiftKey)
    key = event.code.slice(5);
  else if (key === " ") key = "Space";
  else if (key === "+") key = "Plus";
  const symbol = key.length === 1 && !/[A-Za-z0-9]/.test(key);
  const parts = [
    event.ctrlKey ? "Ctrl" : null,
    event.metaKey ? "Cmd" : null,
    event.altKey ? "Alt" : null,
    // A shifted symbol such as "?" already implies Shift.
    event.shiftKey && !symbol ? "Shift" : null,
    key,
  ].filter(Boolean);
  const chord = parts.join("+");
  return parseChord(chord) ? chord : null;
}

const identity = (binding: string) =>
  `${isPrefixBinding(binding)}:${JSON.stringify(parseChord(bindingChord(binding)))}`;

function Keys({ chord }: { chord: string }) {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  return (
    <>
      {[...parts, key].map((part) => (
        <kbd key={part}>
          {SYMBOLS[part] ?? (part.length === 1 ? part.toUpperCase() : part)}
        </kbd>
      ))}
    </>
  );
}

function Binding({
  binding,
  prefix,
  onRemove,
}: {
  binding: string;
  prefix: string | null;
  onRemove(): void;
}) {
  return (
    <span className="settings-binding" title={binding}>
      {isPrefixBinding(binding) && prefix ? (
        <>
          <Keys chord={prefix} />
          <span className="settings-then">then</span>
        </>
      ) : null}
      <Keys chord={bindingChord(binding)} />
      <button
        type="button"
        className="settings-binding-remove"
        aria-label={`Remove ${binding}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

type Recording = { target: Action | "prefix"; afterPrefix: boolean };

export function KeyboardSettings({ context }: { context: FieldContext }) {
  const prefixField = useField(context, "appearance.keyPrefix");
  const timeout = useField(context, "appearance.keyTimeoutMs");
  const bindingsField = useField(context, "appearance.keybindings");
  const history = useField(context, "appearance.terminalHistoryLimit");
  const prefix = prefixField.value as string | null;
  const bindings = {
    ...defaultKeybindings.bindings,
    ...(bindingsField.value as Record<string, string[]>),
  } as Record<Action, string[]>;
  const [recording, setRecording] = useState<Recording | null>(null);
  const [problem, setProblem] = useState<{
    target: string;
    message: string;
  } | null>(null);
  const [filter, setFilter] = useState("");

  const apply = (
    target: string,
    next: Record<Action, string[]>,
    nextPrefix: string | null = prefix,
  ) => {
    const parsed = keybindingsConfig.safeParse({
      version: 1,
      prefix: nextPrefix,
      prefixTimeoutMs: timeout.value,
      bindings: next,
    });
    if (!parsed.success) {
      setProblem({
        target,
        message: parsed.error.issues[0]?.message ?? "Invalid shortcut",
      });
      return;
    }
    setProblem(null);
    const extra =
      nextPrefix !== prefix ? { "appearance.keyPrefix": nextPrefix } : {};
    bindingsField.save(next, extra);
  };

  const add = (action: Action, binding: string) => {
    const taken = (Object.entries(bindings) as [Action, string[]][]).find(
      ([, list]) => list.some((item) => identity(item) === identity(binding)),
    );
    if (taken) {
      setProblem({
        target: action,
        message:
          taken[0] === action
            ? "Already set for this action."
            : `Already used by ${LABELS.get(taken[0])}.`,
      });
      return;
    }
    apply(action, { ...bindings, [action]: [...bindings[action], binding] });
  };

  const setPrefix = (chord: string | null) => {
    const literal = bindings.literal.map((item) =>
      prefix && item === `Prefix ${prefix}` && chord ? `Prefix ${chord}` : item,
    );
    apply("prefix", { ...bindings, literal }, chord);
  };

  useEffect(() => {
    if (!recording) return;
    const cancel = () => setRecording(null);
    const key = (event: KeyboardEvent) => {
      // Capture phase, so Workbench and Tracker shortcuts never see the keys being recorded.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "keydown" || event.repeat) return;
      if (MODIFIER_KEYS.has(event.key)) return;
      const plain =
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (event.key === "Escape" && plain) return cancel();
      const chord = chordFromEvent(event);
      if (!chord) {
        setProblem({
          target: recording.target,
          message: "That key can't be used in a shortcut.",
        });
        return cancel();
      }
      if (recording.target === "prefix") {
        setPrefix(chord);
        return cancel();
      }
      if (!recording.afterPrefix && prefix && matchesChord(prefix, event)) {
        setRecording({ ...recording, afterPrefix: true });
        return;
      }
      add(recording.target, recording.afterPrefix ? `Prefix ${chord}` : chord);
      cancel();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", cancel);
    };
  });

  const recorder = (target: Action | "prefix", label: string) =>
    recording?.target === target ? (
      <span className="settings-recording" role="status">
        {recording.afterPrefix && prefix ? (
          <>
            <Keys chord={prefix} /> then…
          </>
        ) : (
          "Press keys… Esc to cancel"
        )}
      </span>
    ) : (
      <button
        type="button"
        className="settings-add-binding"
        aria-label={label}
        disabled={!!bindingsField.locked}
        onClick={() => {
          setProblem(null);
          setRecording({ target, afterPrefix: false });
        }}
      >
        {target === "prefix" ? "Record" : "+"}
      </button>
    );

  const needle = filter.trim().toLowerCase();
  const stored = ["keybindings", "keyPrefix", "keyTimeoutMs"].some(
    (key) =>
      (
        context.global.stored.appearance as Record<string, unknown> | undefined
      )?.[key] !== undefined,
  );

  return (
    <>
      <Group
        title="Prefix"
        description="Press the prefix, then a key, for tmux-style shortcuts."
      >
        <Row field={prefixField} label="Prefix key">
          {prefix ? (
            <span className="settings-binding">
              <Keys chord={prefix} />
            </span>
          ) : (
            <span className="settings-muted">None</span>
          )}
          {recorder("prefix", "Record prefix key")}
          {prefix ? (
            <button
              type="button"
              className="settings-reset"
              onClick={() => setPrefix(null)}
            >
              Remove
            </button>
          ) : null}
        </Row>
        {problem?.target === "prefix" ? (
          <div
            className="settings-row-error settings-inline-error"
            role="alert"
          >
            {problem.message}
          </div>
        ) : null}
        <Row
          field={timeout}
          label="Wait after prefix"
          description="How long the prefix stays armed."
        >
          <TextInput field={timeout} kind="number" suffix="ms" />
        </Row>
      </Group>
      <div className="settings-keys-toolbar">
        <input
          type="search"
          className="settings-filter"
          placeholder="Filter shortcuts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {stored ? (
          <button
            type="button"
            className="settings-reset"
            onClick={() =>
              context.writer.reset(context.global, [
                "appearance.keybindings",
                "appearance.keyPrefix",
                "appearance.keyTimeoutMs",
              ])
            }
          >
            Reset all shortcuts
          </button>
        ) : null}
      </div>
      {bindingsField.error ? (
        <div className="settings-row-error" role="alert">
          {bindingsField.error}
        </div>
      ) : null}
      {GROUPS.map((group) => {
        const shown = group.actions.filter((action) =>
          `${LABELS.get(action)} ${bindings[action].join(" ")}`
            .toLowerCase()
            .includes(needle),
        );
        if (!shown.length) return null;
        return (
          <Group key={group.title} title={group.title}>
            {shown.map((action) => {
              const changed =
                JSON.stringify(bindings[action]) !==
                JSON.stringify(defaultKeybindings.bindings[action]);
              return (
                <div className="settings-row" key={action}>
                  <div className="settings-row-text">
                    <div className="settings-row-label">
                      {LABELS.get(action)}
                    </div>
                    {problem?.target === action ? (
                      <div className="settings-row-error" role="alert">
                        {problem.message}
                      </div>
                    ) : null}
                  </div>
                  <div className="settings-row-control settings-bindings">
                    {bindings[action].length ? (
                      bindings[action].map((binding) => (
                        <Binding
                          key={binding}
                          binding={binding}
                          prefix={prefix}
                          onRemove={() =>
                            apply(action, {
                              ...bindings,
                              [action]: bindings[action].filter(
                                (item) => item !== binding,
                              ),
                            })
                          }
                        />
                      ))
                    ) : (
                      <span className="settings-muted">Unbound</span>
                    )}
                    {recorder(action, `Add shortcut for ${LABELS.get(action)}`)}
                    {changed ? (
                      <button
                        type="button"
                        className="settings-reset"
                        onClick={() =>
                          apply(action, {
                            ...bindings,
                            [action]: defaultKeybindings.bindings[action],
                          })
                        }
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </Group>
        );
      })}
      <Group title="Terminal">
        <Row
          field={history}
          label="Scrollback"
          description="Lines of history each terminal keeps."
        >
          <TextInput field={history} kind="number" suffix="lines" />
        </Row>
      </Group>
    </>
  );
}
