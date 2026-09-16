import { KEYBINDING_ACTIONS } from "@loom/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  formatBindings,
  type KeybindingsState,
} from "../../shared/keybindings.js";
import { useWindowKeybindings } from "../window-keybindings.js";
import {
  createScrollMatcher,
  scrollBindings,
  scrollDistance,
} from "./scroll-keys.js";
import { formatKeys, trackerKeymap } from "./tracker-keymap.js";

const tabs = ["Everywhere", "Tracker", "Workbench"] as const;
const readingIds = new Set<string>(scrollBindings.map((entry) => entry.id));
const trackerEntries = trackerKeymap.filter(
  (entry) => entry.id !== "help" && !readingIds.has(entry.id),
);
const workbenchEntries = KEYBINDING_ACTIONS.filter(
  (entry) => entry.id !== "help" && entry.id !== "scroll-mode",
);

function BindingRow({
  id,
  label,
  keys,
  source,
}: {
  id: string;
  label: string;
  keys: string;
  source: "tracker" | "workbench";
}) {
  return (
    <div
      data-key-id={source === "tracker" ? id : undefined}
      data-action-id={source === "workbench" ? id : undefined}
    >
      <dt>{label}</dt>
      <dd>
        <kbd>{keys}</kbd>
      </dd>
    </div>
  );
}

export function WindowKeyboardSheet() {
  const { help, bindings, closeHelp } = useWindowKeybindings();
  return help ? (
    <KeyboardSheet bindings={bindings} onClose={closeHelp} />
  ) : null;
}

export function KeyboardSheet({
  bindings,
  onClose,
}: {
  bindings: KeybindingsState;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const matcher = useRef(createScrollMatcher());
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    tabButtons.current[0]?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  const select = (index: number) => {
    matcher.current.reset();
    setSelected(index);
    tabButtons.current[index]?.focus();
    const panel = panels.current[index];
    if (panel) panel.scrollTop = 0;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    const plain =
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (plain && ["ArrowLeft", "ArrowRight", "h", "l"].includes(event.key)) {
      event.preventDefault();
      select(
        (selected +
          (event.key === "ArrowLeft" || event.key === "h"
            ? tabs.length - 1
            : 1)) %
          tabs.length,
      );
      return;
    }
    // Space on a button retains native activation (including the Close button).
    if (
      event.key === " " &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      event.target instanceof HTMLButtonElement
    )
      return;
    const command = matcher.current.match(event);
    if (!command) return;
    event.preventDefault();
    if (command === "leave") return onClose();
    const panel = panels.current[selected];
    if (!panel || command === "pending") return;
    if (command === "top") panel.scrollTop = 0;
    else if (command === "bottom") panel.scrollTop = panel.scrollHeight;
    else panel.scrollTop += scrollDistance(command, panel.clientHeight, 40);
  };

  return (
    <dialog
      ref={dialog}
      className="keyboard-sheet"
      aria-labelledby="keyboard-sheet-title"
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2 id="keyboard-sheet-title">Keyboard map</h2>
          <p>One reference for both windows.</p>
        </div>
        <button
          type="button"
          className="keyboard-sheet-close"
          onClick={onClose}
        >
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <div role="tablist" aria-label="Shortcut surface">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            ref={(element) => {
              tabButtons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`keyboard-tab-${index}`}
            aria-controls={`keyboard-panel-${index}`}
            aria-selected={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onClick={() => select(index)}
          >
            {tab}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab}
          ref={(element) => {
            panels.current[index] = element;
          }}
          className="keyboard-sheet-panel"
          role="tabpanel"
          id={`keyboard-panel-${index}`}
          aria-labelledby={`keyboard-tab-${index}`}
          hidden={selected !== index}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: A scrollable tabpanel must be reachable by keyboard.
          tabIndex={0}
        >
          {index === 0 ? (
            <>
              <p>
                Shared reading keys work in Tracker details and terminal reading
                mode in either window. In lists, use the Tracker navigation
                keys. Other dialogs own their keys.
              </p>
              <div className="keyboard-sheet-grid">
                <section>
                  <h3>Open the map &amp; terminal history</h3>
                  <dl>
                    <BindingRow
                      source="tracker"
                      id="help"
                      label="Keyboard map · Tracker"
                      keys={formatKeys("help")}
                    />
                    {KEYBINDING_ACTIONS.filter(
                      (entry) =>
                        entry.id === "help" || entry.id === "scroll-mode",
                    ).map((entry) => (
                      <BindingRow
                        key={entry.id}
                        source="workbench"
                        id={entry.id}
                        label={`${entry.label} · either window`}
                        keys={formatBindings(bindings.config, entry.id)}
                      />
                    ))}
                  </dl>
                  <p>
                    The configured shortcuts above are editable in Settings →
                    Keyboard, alongside Workbench bindings.
                  </p>
                </section>
                <section>
                  <h3>Reading</h3>
                  <dl>
                    {scrollBindings.map((entry) => (
                      <BindingRow
                        key={entry.id}
                        source="tracker"
                        id={entry.id}
                        label={entry.label}
                        keys={formatKeys(entry.id)}
                      />
                    ))}
                  </dl>
                </section>
              </div>
              <p>
                Tab / Shift+Tab focus controls; Enter / Space activate them.
                Reading page shortcuts also work while typing.
              </p>
            </>
          ) : index === 1 ? (
            <>
              <p>
                Tracker keys are fixed in code. They follow the active list,
                board or detail and pause in inputs, editors and terminals.
              </p>
              <div className="keyboard-sheet-grid">
                {[...new Set(trackerEntries.map((entry) => entry.group))].map(
                  (group) => (
                    <section key={group}>
                      <h3>
                        {group === "Everywhere" ? "Across Tracker" : group}
                      </h3>
                      <dl>
                        {trackerEntries
                          .filter((entry) => entry.group === group)
                          .map((entry) => (
                            <BindingRow
                              key={entry.id}
                              source="tracker"
                              id={entry.id}
                              label={entry.label}
                              keys={formatKeys(entry.id)}
                            />
                          ))}
                      </dl>
                    </section>
                  ),
                )}
              </div>
            </>
          ) : (
            <>
              <p>
                Editable in Settings → Keyboard.{" "}
                {bindings.path
                  ? `Edit ${bindings.path}; changes reload automatically.`
                  : "Using default keybindings."}
              </p>
              <p>
                Prefix: <kbd>{bindings.config.prefix ?? "Disabled"}</kbd>.
                Prefix expires after {bindings.config.prefixTimeoutMs / 1000}{" "}
                seconds. Escape cancels. Modifier keys preserve the prefix;
                unknown suffixes pass through.
              </p>
              {bindings.error ? <p role="alert">{bindings.error}</p> : null}
              <div className="keyboard-sheet-grid">
                {[...new Set(workbenchEntries.map((entry) => entry.group))].map(
                  (group) => (
                    <section key={group}>
                      <h3>{group}</h3>
                      <dl>
                        {workbenchEntries
                          .filter((entry) => entry.group === group)
                          .map((entry) => (
                            <BindingRow
                              key={entry.id}
                              source="workbench"
                              id={entry.id}
                              label={entry.label}
                              keys={formatBindings(bindings.config, entry.id)}
                            />
                          ))}
                      </dl>
                    </section>
                  ),
                )}
              </div>
            </>
          )}
        </div>
      ))}
      <footer>
        ← / → or h / l switch tabs · Tab enters the reference · Reading keys
        scroll
      </footer>
    </dialog>
  );
}
