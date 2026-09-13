// The private tmux configuration, loaded with `-f` when the server is created and therefore
// before any pane exists. Spike 06 verified every option here; the extended-key trio is what
// makes Shift+Enter arrive as CSI-u instead of CR, and changing it after a pane exists does
// not reach that pane.

/** Names of options the adapter sets; `applyConfig` is idempotent, so re-running is safe. */
export const CONFIG_LINES = [
  // Terminal behaviour the embedded and native clients both need (spike 06 §1).
  "set -g mouse on",
  "set -g status off",
  "set -g window-size latest",
  "set -g aggressive-resize on",
  "set -s extended-keys always",
  // `extended-keys-format` arrived in tmux 3.5; Ubuntu's 3.4 (GitHub's runners) rejects it and
  // aborts the whole config. `if-shell -F` evaluates the format in tmux itself, no shell.
  "if-shell -F '#{>=:#{version},3.5}' 'set -s extended-keys-format csi-u'",
  'set -as terminal-features ",xterm*:extkeys:sync"',
  // A dead pane keeps its exit status, which is the only exit fact the host supplies.
  "set -g remain-on-exit on",
  // Attaching a client must never add variables to a pane's environment (spike 06 §3).
  'set -g update-environment ""',
  // Loom relaunches from stored state; tmux must not try to be clever about it.
  "set -g destroy-unattached off",
  "set -g history-limit 20000",
  "set -g base-index 1",
  'set -g @loom_event "init"',
] as const;

export const MONITOR_SESSION = "loom-monitor";
/** The user option the pane-exit hooks bump; the monitor subscribes to its value. */
export const EVENT_OPTION = "@loom_event";
/** Set on every pane Loom starts, so discovery never has to guess from a command name. */
export const RUN_OPTION = "@loom_run";
/**
 * The window that holds a task's session open while its first real window is created. tmux
 * cannot create a session without a window, and a session with none is gone; `listPanes`
 * never reports this one.
 */
export const HOLD_WINDOW = "loom-hold";
/** Set on the throwaway grouped sessions `attachArgs` creates, so `listPanes` skips them. */
export const VIEW_OPTION = "@loom_view";

export function configFile(): string {
  return `${CONFIG_LINES.join("\n")}\n`;
}

/**
 * tmux does not expand `#{…}` in a hook's own arguments (it stores the string verbatim), but it
 * does expand them in `run-shell`'s command, against the pane the hook fired for. The shell then
 * adds its own PID so the value differs on every death — a subscription only reports *changes*.
 */
export function hookCommand(executable: string, socketName: string): string {
  const inner = `${executable} -L ${socketName} set -g ${EVENT_OPTION} "#{pane_id} #{pane_dead_status} $(date +%s)-$$"`;
  return `run-shell -b '${inner.replaceAll("'", `'\\''`)}'`;
}
