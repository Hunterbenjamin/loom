import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  OnHint,
  PaneHost,
  PaneObservation,
  PaneRef,
  WorktreePath,
} from "@loom/core";
import { z } from "zod";
import { baseEnv, createCli, TmuxError, withUtf8Locale } from "./cli.js";
import {
  configFile,
  EVENT_OPTION,
  HOLD_WINDOW,
  hookCommand,
  MONITOR_SESSION,
  RUN_OPTION,
  VIEW_OPTION,
} from "./config.js";
import { startMonitor } from "./monitor.js";
import {
  dedupe,
  PANE_FORMAT,
  type PaneRow,
  parsePanes,
  toObservation,
} from "./panes.js";
import { chunkByBytes, isCommandPrefix, normalizeNewlines } from "./paste.js";

/** The same US separator `panes.ts` uses: safe inside any path or client name. */
const SEP = "\u001f";

export { TmuxError } from "./cli.js";
export { CONFIG_LINES, configFile, MONITOR_SESSION } from "./config.js";
export { dedupe, PANE_FORMAT, parsePanes } from "./panes.js";
export { chunkByBytes, isCommandPrefix, normalizeNewlines } from "./paste.js";

export interface TmuxPaneHostOptions {
  /** `LOOM_INSTANCE`. The socket is `loom-<instance>`, so dev never touches the stable server. */
  instance: string;
  /** Where the private config is written. One file per instance. */
  configPath: string;
  tmuxExecutable?: string;
  /** The environment every tmux *client* runs with. tmux copies PATH from it into new panes. */
  clientEnv?: Record<string, string>;
  commandTimeoutMs?: number;
  /** Time between the paste landing and Enter. 150 ms was enough for both TUIs in spike 06. */
  pasteSettleMs?: number;
  reconnectMs?: number;
  onError?: (error: Error) => void;
}

const name = z
  .string()
  .min(1)
  .max(64)
  // Keep generated socket and workspace keys simple; display names have their own schemas.
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

const windowName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]+$/u, "Names cannot contain control characters");
const sessionName = windowName.regex(
  /^[^.:]+$/,
  "Space names cannot contain . or :",
);
const renameSessionRequest = z.object({
  hostGeneration: z.string().min(1),
  sessionId: z.string().regex(/^\$\d+$/),
  name: sessionName,
});
const renameWindowRequest = z.object({
  hostGeneration: z.string().min(1),
  windowId: z.string().regex(/^@\d+$/),
  name: windowName,
});

const optionsSchema = z.object({
  instance: name,
  configPath: z.string().startsWith("/"),
  tmuxExecutable: z.string().min(1).default("tmux"),
  commandTimeoutMs: z.number().int().positive().default(10000),
  pasteSettleMs: z.number().int().nonnegative().default(150),
  reconnectMs: z.number().int().positive().default(1000),
});

const sessionFor = (taskId: string): string =>
  name.parse(`loom-${taskId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-"));

/** One grouped session per pane: clients then choose their window independently. */
const viewFor = (ref: PaneRef): string =>
  `${ref.sessionName}-v${ref.paneId.slice(1)}`;

export function createTmuxPaneHost(input: TmuxPaneHostOptions): PaneHost {
  const options = optionsSchema.parse(input);
  const socketName = `loom-${options.instance}`;
  const env = input.clientEnv ?? baseEnv();
  const tmux = createCli({
    executable: options.tmuxExecutable,
    socketName,
    timeoutMs: options.commandTimeoutMs,
    env,
  });

  // Mutations that share a session or a pane are serialized in this adapter instance, so a
  // paste can never interleave with another paste's buffer or with a window being created.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };

  let generation: string | null = null;
  let pasteCounter = 0;

  /**
   * tmux exits as soon as it has no sessions, so `start-server` alone leaves nothing behind:
   * the monitor session is what creates the server, and therefore what fixes its environment.
   */
  /** `display-message -p '#{pid}'` is the cheapest proof that the cached generation is real. */
  async function serverPid(): Promise<number | null> {
    try {
      const out = await tmux([
        "display-message",
        "-p",
        "-t",
        MONITOR_SESSION,
        "#{pid}",
      ]);
      return z.coerce.number().int().positive().parse(out.trim());
    } catch (error) {
      if (
        error instanceof TmuxError &&
        ["no_server", "not_found"].includes(error.code)
      )
        return null;
      throw error;
    }
  }

  async function ensureServer(): Promise<string> {
    if (generation) {
      const pid = await serverPid();
      if (pid !== null && `${socketName}#${pid}` === generation)
        return generation;
      // The server died. Every ref minted against it names nothing from here on.
      generation = null;
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(options.configPath, configFile(), "utf8");
    try {
      await tmux([
        "-f",
        options.configPath,
        "new-session",
        "-d",
        "-s",
        MONITOR_SESSION,
        "-n",
        "monitor",
        "--",
        "sleep",
        "2147483647",
      ]);
    } catch (error) {
      if (!(error instanceof TmuxError) || error.code !== "duplicate_session")
        throw error;
    }
    // `-f` is only read when the server starts, so re-apply for a server we did not create.
    await tmux(["source-file", options.configPath]);
    for (const hook of ["pane-died", "pane-exited"])
      await tmux([
        "set-hook",
        "-g",
        hook,
        hookCommand(options.tmuxExecutable, socketName),
      ]);
    const pid = await serverPid();
    if (pid === null) throw new TmuxError("no_server", socketName);
    generation = `${socketName}#${pid}`;
    return generation;
  }

  /** A ref minted against a server that has since died names nothing. */
  async function current(ref: PaneRef): Promise<boolean> {
    return (await ensureServer()) === ref.hostGeneration;
  }

  async function rows(): Promise<PaneRow[]> {
    await ensureServer();
    try {
      return dedupe(
        parsePanes(await tmux(["list-panes", "-a", "-F", PANE_FORMAT])),
      ).filter(
        (row) =>
          !row.isView &&
          row.sessionName !== MONITOR_SESSION &&
          row.windowName !== HOLD_WINDOW,
      );
    } catch (error) {
      if (error instanceof TmuxError && error.code === "no_server") {
        generation = null;
        return [];
      }
      throw error;
    }
  }

  async function observe(
    row: PaneRow,
    hostGeneration?: string,
  ): Promise<PaneObservation> {
    const startCwd = (await realpath(row.startPath).catch(
      () => row.startPath,
    )) as WorktreePath;
    return toObservation(
      row,
      hostGeneration ?? (await ensureServer()),
      startCwd,
    );
  }

  async function sessionExists(session: string): Promise<boolean> {
    try {
      await tmux(["has-session", "-t", `=${session}`]);
      return true;
    } catch (error) {
      if (
        error instanceof TmuxError &&
        ["not_found", "no_server"].includes(error.code)
      )
        return false;
      throw error;
    }
  }

  /**
   * A task's session holds only the windows Loom opened in it: it appears with the first and
   * goes away with the last. tmux cannot create a session without a window, and a pane's
   * environment is fixed when it is spawned, so a throwaway `sleep` window holds the session
   * open just long enough for `create` to scrub the environment and open the real window.
   * `rows()` hides it, and if `create` fails it takes the session down with it.
   */
  async function withSession<T>(
    session: string,
    cwd: WorktreePath,
    create: () => Promise<T>,
  ): Promise<T> {
    if (await sessionExists(session)) return create();
    const hold = (
      await tmux([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        session,
        "-n",
        HOLD_WINDOW,
        "-c",
        cwd,
        "--",
        "sleep",
        "2147483647",
      ])
    ).trim();
    try {
      return await create();
    } finally {
      await tmux(["kill-window", "-t", `${session}:${hold}`]).catch(
        () => undefined,
      );
    }
  }

  /**
   * `-e NAME=` overrides a value but does not remove the name, and `-e PATH=` is overridden by
   * the client's own PATH; only `set-environment -r` removes, and only the client environment
   * decides PATH (spike 06 §3 plus this adapter's own measurement).
   */
  async function scrub(
    session: string,
    wanted: Record<string, string>,
  ): Promise<void> {
    const present = new Set<string>();
    for (const scope of [["-g"], ["-t", session]]) {
      const out = await tmux(["show-environment", ...scope]).catch(() => "");
      for (const line of out.split("\n")) {
        if (!line || line.startsWith("-")) continue;
        const key = line.split("=", 1)[0];
        if (key) present.add(key);
      }
    }
    for (const key of present)
      if (!(key in wanted))
        await tmux(["set-environment", "-t", session, "-r", key]);
  }

  async function findRunPane(runId: string): Promise<PaneRow | null> {
    return (await rows()).find((row) => row.runId === runId) ?? null;
  }

  async function rowFor(ref: PaneRef): Promise<PaneRow | null> {
    if (!(await current(ref))) return null;
    return (
      (await rows()).find(
        (row) => row.paneId === ref.paneId && row.windowId === ref.windowId,
      ) ?? null
    );
  }

  // Keep stored workspace keys usable after a rename and coordinator restart. This is
  // reference metadata on the native session, not a second owner of its display name.
  async function workspaceSession(workspaceId: string): Promise<string> {
    const key = sessionName.parse(workspaceId);
    const matches = (await rows()).filter((row) => row.workspaceId === key);
    const sessions = new Set(matches.map((row) => row.sessionName));
    if (sessions.size > 1) throw new TmuxError("ambiguous_workspace", key);
    return matches[0]?.sessionName ?? key;
  }

  /** Resolves a ref to a live pane Loom owns, or throws. Mutations never guess. */
  async function ownedPane(ref: PaneRef): Promise<PaneRow> {
    const row = await rowFor(ref);
    if (!row) throw new TmuxError("pane_not_found", ref.paneId);
    if (!row.runId) throw new TmuxError("pane_not_owned", ref.paneId);
    if (row.dead) throw new TmuxError("pane_dead", ref.paneId);
    return row;
  }

  return {
    renameSession(req) {
      return exclusive(async () => {
        const parsed = renameSessionRequest.parse(req);
        if ((await ensureServer()) !== parsed.hostGeneration)
          throw new TmuxError("stale_generation");
        const row = (await rows()).find(
          (row) => row.sessionId === parsed.sessionId,
        );
        if (!row) throw new TmuxError("session_not_found", parsed.sessionId);
        if (
          [MONITOR_SESSION, "loom-lead", "loom-main", "loom-operator"].includes(
            parsed.name,
          ) ||
          ["loom-lead", "loom-main", "loom-operator"].includes(row.sessionName)
        )
          throw new TmuxError("reserved_session_name");
        if (row.sessionName === parsed.name) return;
        if (await sessionExists(parsed.name))
          throw new TmuxError("duplicate_session", parsed.name);
        await tmux([
          "set-option",
          "-t",
          parsed.sessionId,
          "@loom_workspace_id",
          row.workspaceId ?? row.sessionName,
        ]);
        await tmux([
          "rename-session",
          "-t",
          parsed.sessionId,
          "--",
          parsed.name,
        ]);
      });
    },

    renameWindow(req) {
      return exclusive(async () => {
        const parsed = renameWindowRequest.parse(req);
        if ((await ensureServer()) !== parsed.hostGeneration)
          throw new TmuxError("stale_generation");
        const row = (await rows()).find(
          (row) => row.windowId === parsed.windowId,
        );
        if (!row) throw new TmuxError("window_not_found", parsed.windowId);
        if (parsed.name === HOLD_WINDOW)
          throw new TmuxError("reserved_window_name");
        await tmux([
          "set-option",
          "-w",
          "-t",
          parsed.windowId,
          "automatic-rename",
          "off",
        ]);
        await tmux(["rename-window", "-t", parsed.windowId, "--", parsed.name]);
      });
    },

    ensureWorkspace(req) {
      return exclusive(async () => {
        await realpath(req.cwd);
        z.string().min(1).parse(req.label);
        await ensureServer();
        return { workspaceId: sessionFor(req.taskId) };
      });
    },

    ensurePane(req) {
      return exclusive(async () => {
        const runId = z.string().min(1).parse(req.runId);
        const cwd = (await realpath(req.cwd)) as WorktreePath;
        const session = await workspaceSession(req.workspaceId);
        const existing = await findRunPane(runId);
        if (existing && !existing.dead)
          return {
            hostGeneration: await ensureServer(),
            sessionName: existing.sessionName,
            windowId: existing.windowId,
            paneId: existing.paneId,
          };
        // A dead pane is the previous attempt's evidence. The coordinator only re-emits
        // `start_run` once it has decided to retry, so replace it rather than resurrect it.
        if (existing) await tmux(["kill-pane", "-t", existing.paneId]);
        return withSession(session, cwd, async () => {
          await scrub(session, req.env);
          const envArgs = Object.entries(req.env).flatMap(([key, value]) => [
            "-e",
            `${key}=${value}`,
          ]);
          const created = (
            await tmux(
              [
                "new-window",
                "-d",
                "-P",
                "-F",
                ["#{pane_id}", "#{window_id}"].join(SEP),
                "-t",
                `${session}:`,
                "-n",
                runId.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32),
                "-c",
                cwd,
                ...envArgs,
                "--",
                req.executable,
                ...req.args,
              ],
              // tmux takes the new pane's PATH from the client process, whatever `-e` says.
              {
                env: {
                  ...env,
                  ...(req.env.PATH ? { PATH: req.env.PATH } : {}),
                },
              },
            )
          ).trim();
          const [paneId, windowId] = z
            .tuple([z.string().regex(/^%\d+$/), z.string().regex(/^@\d+$/)])
            .parse(created.split(SEP));
          await tmux(["set-option", "-p", "-t", paneId, RUN_OPTION, runId]);
          return {
            hostGeneration: await ensureServer(),
            sessionName: session,
            windowId,
            paneId,
          };
        });
      });
    },

    createScratch(req) {
      return exclusive(async () => {
        if (req.split && !req.target) throw new TmuxError("pane_not_found");
        const target = req.target ? await rowFor(req.target) : null;
        if (req.target && !target) throw new TmuxError("pane_not_found");
        if (target?.dead) throw new TmuxError("pane_not_found");
        const session =
          target?.sessionName ?? (await workspaceSession(req.workspaceId));
        const key = z.string().uuid().parse(req.key);
        const cwd = (await realpath(req.cwd)) as WorktreePath;
        const windowName =
          req.label === undefined
            ? `scratch-${key}`
            : z
                .string()
                .trim()
                .min(1)
                .max(80)
                .regex(/^[^\p{Cc}]+$/u)
                .parse(req.label);
        await ensureServer();
        return withSession(session, cwd, async () => {
          const stale: string[] = [];

          for (const row of (await rows()).filter(
            (r) => r.sessionName === session,
          )) {
            const recordedKey = await tmux([
              "show-option",
              "-p",
              "-v",
              "-q",
              "-t",
              row.paneId,
              "@loom_scratch_key",
            ]);
            if (recordedKey.trim() === key) {
              if (!row.dead) return (await observe(row)).ref;
              stale.push(row.paneId);
            }
          }
          await scrub(session, req.env);
          const output = await tmux(
            [
              ...(req.split
                ? ["split-window", req.split === "right" ? "-h" : "-v"]
                : ["new-window"]),
              "-d",
              "-P",
              "-F",
              "#{pane_id}",
              "-t",
              ...(req.split && target
                ? [target.paneId]
                : [`${session}:`, "-n", windowName]),
              "-c",
              cwd,
              ...Object.entries(req.env).flatMap(([k, v]) => [
                "-e",
                `${k}=${v}`,
              ]),
              "--",
              req.executable,
              ...req.args,
            ],
            {
              env: { ...env, ...(req.env.PATH ? { PATH: req.env.PATH } : {}) },
            },
          );
          if (req.label !== undefined && !req.split)
            await tmux([
              "set-option",
              "-w",
              "-t",
              output.trim(),
              "automatic-rename",
              "off",
            ]);
          await tmux([
            "set-option",
            "-p",
            "-t",
            output.trim(),
            "@loom_scratch_key",
            key,
          ]);
          for (const paneId of stale) await tmux(["kill-pane", "-t", paneId]);
          const created = (await rows()).find(
            (r) => r.paneId === output.trim(),
          );
          if (!created) throw new TmuxError("pane_not_found", output.trim());
          return (await observe(created)).ref;
        });
      });
    },

    async getPane(ref) {
      const row = await rowFor(ref);
      return row ? observe(row) : null;
    },

    async listPanes() {
      const snapshot = await rows();
      const hostGeneration = generation as string;
      return Promise.all(snapshot.map((row) => observe(row, hostGeneration)));
    },

    pasteText(ref, text) {
      return exclusive(async () => {
        const raw = z.string().min(1).parse(text);
        if (isCommandPrefix(raw)) throw new TmuxError("refused_command_prefix");
        const row = await ownedPane(ref);
        const normalized = normalizeNewlines(raw);
        const buffer = `loom-paste-${process.pid}-${++pasteCounter}`;
        const chunks = chunkByBytes(normalized);
        for (const [index, chunk] of chunks.entries())
          await tmux([
            "set-buffer",
            ...(index === 0 ? [] : ["-a"]),
            "-b",
            buffer,
            "--",
            chunk,
          ]);
        try {
          // `-p` brackets the paste so a TUI reads it as pasted text, `-d` drops the buffer.
          await tmux([
            "paste-buffer",
            "-p",
            "-d",
            "-b",
            buffer,
            "-t",
            row.paneId,
          ]);
        } catch (error) {
          await tmux(["delete-buffer", "-b", buffer]).catch(() => undefined);
          throw error;
        }
        await delay(options.pasteSettleMs);
        await tmux(["send-keys", "-t", row.paneId, "Enter"]);
        // Bytes were written. Whether they became a prompt is the provider's to say.
        return "written" as const;
      });
    },

    sendKey(ref, key) {
      return exclusive(async () => {
        const row = await ownedPane(ref);
        await tmux([
          "send-keys",
          "-t",
          row.paneId,
          z.literal("Escape").parse(key),
        ]);
      });
    },

    attachArgs(ref) {
      const view = viewFor(ref);
      // A grouped session shares the window list but keeps its own current window, so two
      // terminals can show different runs of one task at the same time. Any number of clients
      // may attach to the same view; there is no takeover.
      return [
        options.tmuxExecutable,
        "-L",
        socketName,
        "new-session",
        "-A",
        "-d",
        "-s",
        view,
        "-t",
        ref.sessionName,
        ";",
        "set-option",
        "-t",
        view,
        VIEW_OPTION,
        "1",
        ";",
        "set-option",
        "-t",
        view,
        "destroy-unattached",
        "on",
        ";",
        "select-window",
        "-t",
        `${view}:${ref.windowId}`,
        ";",
        "attach-session",
        "-f",
        "active-pane",
        "-t",
        view,
        ";",
        "select-pane",
        "-t",
        `${view}:${ref.windowId}.+`,
        ";",
        "select-pane",
        "-t",
        ref.paneId,
      ];
    },

    async listClients(ref) {
      const row = await rowFor(ref);
      if (!row) return [];
      const group = (
        await tmux([
          "display-message",
          "-p",
          "-t",
          row.sessionId,
          "#{session_group}",
        ])
      ).trim();
      const out = await tmux([
        "list-clients",
        "-F",
        [
          "#{client_name}",
          "#{client_width}",
          "#{client_height}",
          "#{session_name}",
          "#{session_group}",
        ].join(SEP),
      ]);
      const client = z.tuple([
        z.string().min(1),
        z.coerce.number().int().positive(),
        z.coerce.number().int().positive(),
        z.string(),
        z.string(),
      ]);
      const clients = [];
      for (const line of out.split("\n")) {
        if (!line) continue;
        const parsed = client.safeParse(line.split(SEP));
        if (!parsed.success) continue;
        const [id, cols, rows_, session, clientGroup] = parsed.data;
        if (session === MONITOR_SESSION) continue;
        // Count session-group attachments; this does not identify the pane each client focuses.
        if (session !== row.sessionName && (!group || clientGroup !== group))
          continue;
        clients.push({ id, cols, rows: rows_ });
      }
      return clients;
    },

    closePane(ref) {
      return exclusive(async () => {
        const row = await rowFor(ref);
        if (!row) return;
        if (!row.runId) throw new TmuxError("pane_not_owned", ref.paneId);
        await tmux(["kill-pane", "-t", row.paneId]).catch((error) => {
          if (!(error instanceof TmuxError) || error.code !== "not_found")
            throw error;
        });
      });
    },

    closeTerminal(ref) {
      return exclusive(async () => {
        // The close path additionally requires the current session name. rows excludes the
        // monitor and viewer sessions. This path is only exposed to explicit human commands.
        const row = await rowFor(ref);
        if (!row || row.sessionName !== ref.sessionName) return;
        await tmux(["kill-pane", "-t", row.paneId]).catch((error) => {
          if (!(error instanceof TmuxError) || error.code !== "not_found")
            throw error;
        });
      });
    },

    closeWindow(ref) {
      return exclusive(async () => {
        const row = await rowFor(ref);
        if (!row || row.sessionName !== ref.sessionName) return;
        await tmux(["kill-window", "-t", row.windowId]).catch((error) => {
          if (!(error instanceof TmuxError) || error.code !== "not_found")
            throw error;
        });
      });
    },

    closeSession(ref) {
      return exclusive(async () => {
        const row = await rowFor(ref);
        if (!row || row.sessionName !== ref.sessionName) return;
        await tmux(["kill-session", "-t", `=${row.sessionName}`]).catch(
          (error) => {
            if (!(error instanceof TmuxError) || error.code !== "not_found")
              throw error;
          },
        );
      });
    },

    subscribe(onHint: OnHint) {
      void ensureServer().catch((error: Error) => input.onError?.(error));
      return startMonitor({
        executable: options.tmuxExecutable,
        socketName,
        env: withUtf8Locale(env),
        reconnectMs: options.reconnectMs,
        onError: input.onError,
        // The host never says what changed: a hint is a reason to re-read, not a fact.
        onInvalidated: () =>
          onHint({ source: "pane_host", worktreePath: null, sessionId: null }),
      });
    },
  };
}

export { EVENT_OPTION, HOLD_WINDOW, RUN_OPTION, VIEW_OPTION };
