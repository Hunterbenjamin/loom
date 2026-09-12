# Spike 06: Does tmux meet the pane-host budgets Herdr met?

**Recommendation: tmux for Loom's future `PaneHost`, with provider-owned prompt guards.** It met the
measured terminal latency budget, supported concurrent clients, and recovered without Herdr's
canonical-resume/rename/session-report workarounds. It does **not** make arbitrary terminal input safe:
a paste followed by Enter approved our pending Claude permission dialog instead of delivering a prompt.
The proposed migration must implement that guard before adopting the transport.

Versions: tmux **3.7c** (already installed through Homebrew); Claude Code **2.1.269**, Haiku 4.5;
codex-cli **0.154.0**, **gpt-5.6-luna**, low effort; native Ghostty **1.3.1**; Electron **44.3.0**;
xterm.js **6.0.0**, WebGL **0.19.0**, fit **0.11.0**, unicode-graphemes **0.4.0**;
node-pty **1.1.0**; Playwright **1.63.0**; ws **8.21.3**; zod **4.3.6**;
Node **23.6.0**, Python **3.13.1**, pnpm **10.0.0**, Git **2.51.2**; macOS **26.2 (25C56)**.
`model/list` advertised Luna as “Fast and affordable agentic coding model,” as in spike 05. That endpoint
provides neither prices nor parameter counts; it does not establish a price ranking against Spark or Reserve.
No larger model was used for these probes.

Run: 2026-09-12, approximately **05:34–06:01 UTC**, within the two-hour experiment timebox;
approval waits excluded. Every tmux command used `-L loom-s06`. Data and the throwaway Git repo lived
under `$TMPDIR/loom-spike-06` (`$SPIKE` below). Both providers' IDs were recorded before their first turn.
The private app-server ran **outside tmux**, with its own `CODEX_HOME` and Unix socket. Its authentication
link reused existing CLI credentials without reading or printing them. No Herdr command, shared Codex
daemon operation, global settings edit, or product-code change was made.

## Summary

| Question | Result | One-line answer |
|---|---|---|
| 1. Electron attach and latency | works with caveats | Echo p95 **6.2 / 5.1 / 5.5 ms** (3 × 30 keys), below 16 ms; mouse, scrollback and bracketed paste pass; Shift+Enter needs tmux extended-key configuration as well as the renderer shim. |
| 1b. Electron + native Ghostty | works with caveats | Both attach simultaneously; Ghostty input is visible in Electron; latest active client's size wins. Reverse native visual inspection was blocked and remains unverified. |
| 2. Prompt delivery | works with caveats | **89/89 plain-text prompts exactly once**, **87 byte-identical**; 20 KB requires chunked `set-buffer`; slash/bang remain UI commands. Raw delivery at a permission dialog approved the pending command. |
| 3. Environment | works with caveats | **`-e` does not remove variables.** `set-environment -r` plus an allowlisted server environment prevents inherited test markers; confirmed inside Claude's tool process. |
| 4. Exit and restart | works with caveats | `pane_dead` detects TUI exit; `%exit` is a client/server-disconnection signal. All four faulted Codex turns completed outside tmux; Claude resumed with its ID/settings but lost its in-flight turn. Both resumed TUIs answered fresh prompts in **31.0 / 30.2 s**. |
| 5. Escape interrupt | works | Claude became provider-idle in **134 ms** with a transcript interruption marker; Codex's native turn became `interrupted` in **71 ms**. |
| 6. Read-only discovery | works with caveats | A fresh process joins panes/providers on realpath(cwd); command strings are `2.1.269` / `node`, so cwd/pid/command alone do not identify every provider session. Keep durable run/session links. |

## Comparison with Herdr

Herdr figures are the checked-in [spike 02](../02-claude-hooks/FINDINGS.md),
[spike 03](../03-embedded-terminal/FINDINGS.md), and [spike 05](../05-restart-matrix/FINDINGS.md)
measurements, **not reruns**. Different provider patch versions, host settings and run conditions prevent
attributing every latency difference to the host.

| Measurement | tmux 3.7c, this run | Herdr 0.9.0, prior runs |
|---|---|---|
| Local `cat` echo p95, same Electron harness | 5.8 / 5.0 / 5.3 ms | 11.6 ms (spike 03 xterm) |
| Hosted `cat` echo p50 / p95 | 5.1 / 6.2; 5.0 / 5.1; 5.1 / 5.5 ms | 6.6 / 10.9 ms (spike 03); this brief separately cites 9 ms from the shell PR |
| Claude prompt echo p95 | 15.7 / 12.7 / 9.3 ms | 28.1 ms |
| Simultaneous ordinary attach clients | 2, no eviction | 1; second refused unless takeover |
| Plain prompts, exactly once / byte-identical | 89/89 / 87/89 | 89/89 / 87/89 |
| Send → UserPromptSubmit, <5 KB (n=79), median / p95 | 198 / 249 ms, **includes deliberate 150 ms paste-settle delay** | 311 / 322 ms |
| 20 KB (n=10), median send → submit | 220 ms, with chunked buffer construction | 421 ms |
| Prompt while working | Accepted, same prompt_id, one Stop | Same |
| Prompt while permission-blocked | Transport accepts; **Enter approved the tool**, 0 submissions | `agent_blocked`, no input sent |
| Environment removal | `-e NAME` and `-e NAME=` leave names present; explicit removal needed | Server inheritance also needs scrubbing; shell prelude used by adapter |
| Host down / new host ready | 8.5–10.5 / 24.6–27.8 ms (n=3 timed faults) | Graceful stop 0.7–0.9 s; new server about 0.25 s |
| Relaunch commands returned / Claude provider ready | 38.8–40.6 ms / 1.20–1.51 s | About 20 s for both launches, including Codex's readiness timeout |
| Fault → both fresh replies through resumed TUIs | 30.98 / 30.20 s (n=2) | 34.6 s (n=1) |
| Mid-turn Codex survival, server outside pane host | 4/4 completed (one partial timing run) | 6/6 completed |
| Claude mid-turn recovery | Same session; interrupted work not completed | Same loss |

The recovery timings include waiting for a deliberately **25-second tool call** to finish, then fresh
prompts. Herdr's experiment used roughly 30 seconds and different readiness checks; the totals are not a
controlled speedup comparison. Returning a pane ID in 40 ms is also **not** provider readiness.

## Evidence

The committed [evidence](evidence/) contains sanitized summaries, per-prompt hashes and receive counts,
raw latency samples, native provider outcomes, and an [Electron screenshot](evidence/electron-two-clients.png).
Raw transcripts, hooks, credentials and service logs stay in the private temporary fixture.

### 1. Electron, keys, scroll, and two clients

`main.cjs`, `preload.cjs`, `renderer.mjs`, `index.html` and `keylog.py` reuse spike 03's harness. The driver
opens the same terminal with this command:

```sh
/opt/homebrew/bin/tmux -L loom-s06 attach -t s06:claude
```

`node electron-probe.mjs latency`: 3 repetitions, local cat, hosted cat, Claude prompt; 30 DOM keystrokes
80 ms apart per cell. The metric is exactly spike 03's **keydown → first parsed write moving the cursor**,
a glyph-latency proxy, not a physical display/presentation measurement. Window: 1400 × 900, terminal
183 × 52, WebGL active, Unicode `15-graphemes`. Every cell recorded 30/30 keys. Max hosted-cat latency
was 6.2 ms; max Claude latency was 28.1 ms even though all three p95 values met 16 ms.

`node electron-probe.mjs keys` used the raw logger, not an agent transcript, to check terminal bytes:

```text
mouse click:  sent/received ESC[<0;11;3M ESC[<0;11;3m
wheel:        sent/received ESC[<64;11;3M
paste:        sent/received ESC[200~S06-line1\rS06-line2 ESC[201~
Shift+Enter:  renderer sent ESC[13;2u; default tmux delivered \r
```

This configuration was sufficient after creating a fresh pane:

```tmux
set -g mouse on
set -g status off
set -g window-size latest
set -g aggressive-resize on
set -s extended-keys always
set -s extended-keys-format csi-u
set -as terminal-features ",xterm*:extkeys"
```

Changing the server options alone left the existing logger in `VT10x` mode and still delivered CR.
Respawning the **owned logger** changed the result to `ESC[13;2u`. The resumed Codex TUI was also
recreated under these settings. `shift-agents` then showed `a` and `b` on separate input lines in
**both providers**, without submitting them. Claude had no UserPromptSubmit during the probe; Codex's
thread still contained only its prior turns. The minimum subset of the three extended-key options was
not isolated. Related upstream [Codex issue #21699](https://github.com/openai/codex/issues/21699) describes
older extended-key negotiation behavior; our result is from the installed 0.154.0, not that issue's version.

`node electron-probe.mjs scroll`: first wheel event entered tmux copy mode; five events moved the first
visible line **450 → 430**, and native `#{pane_in_mode}|#{scroll_position}` reported **`1|20`**.
Thus ordinary wheel scrolling reaches tmux history rather than recalling shell input history.

`ghostty` ran twice successfully, using spike 03's owned-window AppleScript mechanism. Trimmed native
metadata and Electron readback:

```text
Electron only:        client 183x52; pane 183x52
Ghostty attaches:     clients 183x52, 186x49; pane 186x49
Electron types:       pane 183x52
Ghostty types:        pane 186x49
Electron text:        ...S06_FROM_ELECTRONS06_FROM_GHOSTTY
Electron resize/type: client/pane 116x33; Ghostty still 186x49
Ghostty detached:     Electron client alone; pane 116x33
```

The shared pane has one size; a differently sized view gets cropping/padding. Both clients remain
attached. Detaching one does not terminate the pane. **Electron → Ghostty visual rendering was not
verified**: native window screenshot lookup returned no usable target, and computer-use explicitly
blocked Ghostty. The attempted third visual-only pass was stopped. This does not invalidate the
native two-client/resize observations or Ghostty → Electron readback. Independent window selection
for different task views in a shared tmux session was not tested.

### 2. The 100 prompts and delivery-state tests

`probe.py bulk` imports **the exact `build()` fixture generator** from spike 02. Each prompt was sent
using a private named buffer, bracketed paste, a 150 ms settle interval, then Enter. The runner waited
for the provider's Stop between normal prompts, never terminal text. `analyze.py` independently
recounted unique markers across the **whole session**, finding no late duplicates.

```sh
tmux -L loom-s06 set-buffer -b s06-prompt -- '<text>'
tmux -L loom-s06 paste-buffer -p -d -b s06-prompt -t s06:claude
# 150 ms settle
tmux -L loom-s06 send-keys -t s06:claude Enter
```

A single 20 KB `set-buffer` failed with **`command too long`** before pasting P055. This is tmux's CLI
message limit, also visible in its [client implementation](https://github.com/tmux/tmux/blob/master/client.c).
The corrected path used `set-buffer` for the first 4096-character chunk and `set-buffer -a` for each
remaining chunk, then **one** paste and Enter. All ten 20 KB fixtures were ASCII, so those chunks were
also bounded to 4096 bytes. P055 had one rejected pre-send attempt and one actual delivery, not two
submissions. Production chunking must bound UTF-8 **bytes**, or separately validate `load-buffer -`.

```text
short 20/20; multiline 20/20; 2 KB 15/15; 20 KB 10/10
special 20/20 delivered, 18/20 byte-identical
slash-path 4/4; slash-word 0/5; bang 0/6
whole-session UserPromptSubmit: 89; duplicates: 0
```

P075 normalized tabs to four spaces. P076's `\r\n` became **`\n\n`**, unlike Herdr's `\n` result.
The default tmux paste path translates line endings; normalize CRLF before transport and verify the
normalization contract. A raw-preserving paste variant was not tested. `/p085x` etc. produced no prompt
submission; `!echo p094-bang` etc. ran Claude's Bash-mode echo and produced no UserPromptSubmit.
Do not use arbitrary slash/bang-leading text as a programmatic prompt.

`lifecycle.py working`, once: a second prompt during `python3 hold.py` arrived in **174.4 ms**;
both receipts had the same `prompt_id`, there was one Stop, and the reply included both markers.

`lifecycle.py blocked`, once: Claude was provider-`waiting` on a PermissionRequest for
`touch s06-permission.txt` in the fixture repo. The raw transport reported success. Three seconds later:

```json
{"promptSubmits":0,"postToolUses":1,"fileExists":true,"events":["PostToolUse","Stop"]}
```

**Enter approved the pending tool.** The pasted text was not delivered as a new prompt. This is why
transport success must mean only “bytes written.” Use the provider to refuse injection when waiting
for input/approval or when state is unknown; serialize injection per pane and confirm a matching
UserPromptSubmit. A state-check/input race still exists and must be handled as uncertain delivery,
not automatically retried. Approval dialogs belong to the human/native approval channel.

### 3. Environment

Started the private server with fake `CLAUDE_CODE_S06=fake`, `HERDR_S06=fake`, and
`S06_SERVER_SENTINEL=server-only`. Two short-lived windows ran the environment probe:

```sh
tmux -L loom-s06 new-window -d -c "$SPIKE/repo" \
  -e CLAUDE_CODE_S06 -e HERDR_S06 python3 "$SPIKE/repo/env-probe.py"
# Repeat with -e CLAUDE_CODE_S06= -e HERDR_S06=
```

Both printed:

```json
{"scrubbed_present":["CLAUDE_CODE_S06","HERDR_S06"],"sentinel":"server-only"}
```

So the brief's `-e` removal assumption is false: it can override a value with an empty value, but does
not remove the name, and it does not isolate the rest of the server environment. Before launching
Claude, `launch.py` read environment **names** and marked 55 unwanted inherited variables for removal
with `set-environment -r -t s06 NAME`. `update-environment` was empty to prevent attach-time additions.
The restart harness started the private server with an explicit environment allowlist.

Claude then ran `python3 env-probe.py` through Bash. The actual tool response had **no fake marker
names**, and `sentinel: null`. Its additional `CLAUDE_CODE_*` variables were created by Claude for its
own tool subprocess, including `CLAUDE_CODE_CHILD_SESSION`; those are not evidence of inherited
launcher contamination. Resumes and transcript persistence worked. Only names and harmless sentinel
values were inspected; no token/credential values were logged. This is a controlled leakage probe,
not proof that arbitrary future environment additions are safe. Codex tool execution inherits the
external app-server's environment, so that process needs its own scrub policy too.

### 4. Exit, fault, recovery and discovery

`lifecycle.py exit`, once: an idle Codex TUI exited after Ctrl+C; the pane remained with
`pane_dead=1`, `pane_dead_status=0` in **344 ms** (including the intentional 300 ms key gap).
`pane_current_path` was empty for the dead pane, while `pane_start_path` retained the fixture path.
The control client remained alive and emitted **zero `%exit` notifications**. Use `pane_dead`,
a pane-exit hook/format subscription, or polling for pane exits; `%exit` means the **control client**
is leaving. Hook/format-subscription delivery latency was not measured.

`restart.py` stored provider IDs and the intended cwd/flags/config, confirmed Claude `busy` plus a
Bash PreToolUse, and confirmed Codex `active` plus a native `commandExecution` item started. Then:

```sh
tmux -L loom-s06 kill-server
# Recreate the server/session with the saved private config and environment.
# Recreate windows with -c "$SPIKE/repo" and the original full launch recipe:
claude --resume <stored-id> --settings "$SPIKE/settings.json" --model haiku
codex resume <stored-thread> --remote "unix://$SPIKE/codex.sock" -c 'model="gpt-5.6-luna"'
```

The recovery procedure did not depend on previous pane IDs or any host restore feature. IDs alone
are not the entire launch recipe: cwd, settings, model, socket and environment policy are also durable
coordinator configuration, exactly as in spike 05.

| Applied fault | New host | Both launches returned | Claude resume + idle | Both fresh replies | Codex faulted turn |
|---|---:|---:|---:|---:|---|
| 1 | ~24 ms | not recorded | confirmed later | not timed | completed |
| 2 | 24.6 ms | 38.8 ms | 1.51 s | 29.81 s; Claude via TUI, Codex via RPC | completed |
| 3 | 27.1 ms | 40.6 ms | 1.25 s | **30.98 s; both via TUI** | completed |
| 4 | 27.8 ms | 40.3 ms | 1.20 s | **30.20 s; both via TUI** | completed |

All four Codex turns completed after losing their TUI; the external app-server PID stayed alive.
Every old pane process checked in the three complete timing runs was gone. Claude returned with the
same UUID, `SessionStart source=resume`, and fresh prompts reached its retained settings/hooks. Its
faulted turns had no completed assistant answer. Do not replay interrupted tools blindly; reconcile
the actual task's effects first. Control mode emitted `%exit` at each fully recorded host fault.

Two setup/measurement failures are retained rather than counted as successful timed trials:
(a) one pre-fault attempt failed its guard because thread/read did not expose the live command item,
while native item events did; no host fault was applied; (b) fault 1's timing recorder rejected an
optional field in an unrelated Claude discovery entry after launching both replacement panes.
Fresh provider readback established continuity, but that run is excluded from the timing cohort.

`lifecycle.py discover` is a fresh read-only process. After the final restart it found:

```text
pane  command   cwd          provider correlation
%0    cat       $SPIKE/repo  fixture anchor
%1    2.1.269   $SPIKE/repo  Claude's native pid equals pane_pid; same stored UUID
%2    node      $SPIKE/repo  Codex launcher; stored thread/read confirms its provider state
```

Cwd gives the task join, not a unique provider identity. PIDs/commands alone cannot recover the Codex
thread ID through its Node launcher. Keep durable run/session records, inspect owned process argv or
optional tmux user-option tags as hints, and reject ambiguous matches. `pane_start_path` helps after
exit; realpath normalizes `/var` versus `/private/var`. Pane IDs restarted at `%0` after server death,
so scope references to a server generation. Never derive agent working/blocked state from this table.

### 5. Interrupt

Once per provider, `tmux -L loom-s06 send-keys -t s06:<provider> Escape`:

- Claude, during the 25-second Bash tool: native status became idle in **133.8 ms**; no subsequent hook
  fired for the interrupt. Transcript text: `[Request interrupted by user for tool use]`. The initial
  exact-string counter missed the suffix; the committed evidence records the corrected transcript readback.
- Codex, during an active turn before its command item began: `thread/read` changed that exact turn
  from `inProgress` to **`interrupted`** in **71.4 ms**. No terminal-screen heuristic was used.

## Implications for Loom: proposed `PaneHost`

This is a proposal, not a product adapter or an architecture migration. `packages/*` imports none of
this spike. If adopted, update `docs/architecture.md` to name the selected pane host as terminal owner,
replace the Herdr-specific attach/recovery rules, and keep provider status/transcript ownership unchanged.

The current contract is `packages/core/src/adapters.ts`'s `HerdrAdapter`:

| Current method | tmux needs | Proposed disposition |
|---|---|---|
| `openWorkspace` | An idempotent task-scoped terminal group, cwd and label | `ensureWorkspace`; no Git/worktree ownership moves to tmux |
| `startAgent` | Launch the stored executable/argv directly, with cwd and explicit environment | `ensurePane`; readiness comes from provider adapters; do not type a shell prelude |
| `getAgent`, `listAgents` | Native pane metadata, exit data and canonical cwd | `getPane`, `listPanes`; drop screen-derived agent state and inferred session identity |
| `prompt` | A transport write for provider-approved text | `pasteText`; returns `written` or an error, never `delivered`, `idle` or `blocked` |
| `interrupt` | Escape delivery | `sendKey`; prefer native Codex turn/interrupt for coordinator control; verify via provider |
| `reportSession` | No integration-hook repair | Remove from host contract; coordinator owns links; optional volatile tags only assist discovery |
| `attachArgs` | Explicit socket/session/pane target | Retain; no takeover/eviction flow for ordinary concurrent attach |
| `subscribe` | Host/pane invalidation hints and disconnects | Retain; no stdout status parsing; reconnect then list metadata; add exit polling as needed |

A possible TypeScript surface:

```ts
type PaneRef = { hostGeneration: string; sessionId: string; paneId: string };
type PaneSnapshot = {
  ref: PaneRef;
  cwd: string | null;
  startCwd: string;
  pid: number;
  command: string;
  dead: boolean;
  exitCode: number | null;
};
interface PaneHost {
  ensureWorkspace(input: { taskId: string; cwd: string; label: string }): Promise<string>;
  ensurePane(input: {
    workspaceId: string;
    runId: string; // stable idempotence key persisted before launch
    cwd: string;
    executable: string;
    args: string[];
    env: Record<string, string>; // complete permitted inheritance, not a few overrides
  }): Promise<PaneRef>;
  getPane(ref: PaneRef): Promise<PaneSnapshot | null>;
  listPanes(): Promise<PaneSnapshot[]>;
  pasteText(ref: PaneRef, text: string): Promise<"written">;
  sendKey(ref: PaneRef, key: "Escape"): Promise<void>;
  attachArgs(ref: PaneRef): string[];
  listClients(ref: PaneRef): Promise<Array<{ id: string; cols: number; rows: number }>>;
  closePane(ref: PaneRef): Promise<void>; // only an explicitly owned pane
  subscribe(onInvalidated: () => void): () => void;
}
```

New requirements compared with the current Herdr contract:

- Host-generation identity, explicit environment construction/removal, native exit facts, and client
  enumeration/sizing policy. Keep session/window provisioning and mutation serialization in the host
  adapter; preserve the intended launch recipe in durable coordinator state before starting it.
- Unique per-operation paste buffers, byte-bounded construction, deterministic newline normalization,
  provider-state gating, and receipt-based confirmation. Never replay an uncertain paste automatically.
- Session/group design for independent task views. Two clients sharing a tmux session also share its
  selected window; decide whether each task/provider gets a session or viewers get grouped sessions.
  Grouped-session behavior is a follow-up, not validated by this same-target experiment.
- A private tmux config loaded before pane creation, with the tested extended-key and mouse settings.
  The app still needs xterm's small Shift+Enter shim; tmux does not replace that renderer responsibility.

Work that disappears: Herdr agent naming/readiness-timeout workarounds, `reportSession` repair after
resume, canonical auto-restore cleanup, manifest-based screen state, and exclusive-attach takeover UI.
Codex's external app-server, Claude's settings file, provider session persistence, trust handling,
provider-confirmed prompt delivery and coordinator reconciliation remain necessary.

## Open questions and limits

- Reverse Electron → native Ghostty visual verification remains blocked; native Ghostty keyboard
  Shift+Enter was not independently retested. Electron + tmux + both providers was tested.
- No throughput flood, battery/load test, full Electron crash matrix, tmux SIGKILL, machine reboot,
  minimum supported tmux version, or non-macOS run was added; these were outside this brief's core matrix.
- The provider-state check/input race at permission transitions needs an explicit design and tests.
  Provider-native/headless control remains preferable where available.
- Environment isolation is an allowlist policy, not a property of `-e`. tmux pane metadata and tags are
  not durable across host death. Neither should become a new owner for provider session identity.
- Minimum extended-key config, byte-safe `load-buffer -`, CRLF-preserving paste, pane-exit subscription
  latency, and grouped-session independent selection remain unmeasured.

## How to rerun

These are manual, opt-in real-provider probes; `pnpm test` never launches them. Existing subscribed CLI
authentication is required. Review prompts only in the throwaway repo. Never point a command at another
server/session, and never reuse a nonempty fixture directory.

```sh
cd spikes/06-tmux-pane-host
npm install
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
node node_modules/electron/install.js
export LOOM_REAL_PROVIDERS=1
python3 setup.py                       # fresh $TMPDIR/loom-spike-06 only
# If socket creation was sandbox-blocked, retry start.py with tool approval.
# launch.py removes inherited names at session scope before starting Claude.
python3 probe.py env-baseline          # before removing the server markers
python3 launch.py
node rpc.mjs models
node rpc.mjs start                     # records ID, then first trivial turn on SAME connection
# Create Codex's TUI with common.launch('codex') after that first turn:
python3 -c 'from common import launch; print(launch("codex"))'
python3 probe.py status claude         # inspect only the owned fixture trust dialog
python3 probe.py trust-claude          # only if that exact No/Yes trust dialog is visible
python3 probe.py send 'Reply exactly S06_READY. Do not use tools.'
node electron-probe.mjs latency
python3 probe.py keys
node electron-probe.mjs keys            # baseline, before extended-key configuration
python3 probe.py bulk                  # 100 fixtures; chunked buffer path handles 20 KB
python3 analyze.py
python3 probe.py environment
python3 lifecycle.py working
python3 lifecycle.py blocked           # deliberately tests one harmless fixture touch approval
python3 lifecycle.py interrupt-claude
python3 lifecycle.py interrupt-codex
python3 lifecycle.py exit
python3 lifecycle.py discover
```

For the successful key configuration, add the three `extended-keys`/`terminal-features` settings above
to `$SPIKE/tmux.conf`, load it with `tmux -L loom-s06 source-file "$SPIKE/tmux.conf"`, and recreate only
the owned key logger/TUI. `probe.py keys` creates the logger; after a host restart it is absent and can
be created again. Run `electron-probe.mjs keys`, `shift-agents`, `scroll`, and `ghostty` separately;
clients on the same session share window selection. The native Ghostty driver uses the previously
authorized spike 03 AppleScript mechanism; do not use it to work around a platform app-access denial.

```sh
python3 restart.py 1                   # repeat with a new numeric trial label
python3 restart.py 2
python3 lifecycle.py discover          # fresh-process read-only join after host death
python3 cleanup.py                     # idle guards; only owned host/service process groups
python3 export-evidence.py             # sanitized summaries in $SPIKE/exported-evidence
```

`start.py` is setup-error recovery only, not the restart experiment. `rpc.mjs` uses spike 05's
`ws+unix://...:/rpc` transport with bounded requests and zod validation. The
[official app-server documentation](https://learn.chatgpt.com/docs/app-server) confirms the Unix
WebSocket transport and remote TUI connection; live behavior here was measured on 0.154.0.
Copy reviewed exports into `evidence/` for a new report; missing trial labels are skipped.
Python polling/fixture helpers reuse spike 02's approach; their external JSON validation bridge is
`validate.mjs`. The final runnable entry points enforce the explicit opt-in flag.

Validation: **369 tests passed, 3 opt-in tests skipped**; `pnpm lint` and `pnpm typecheck` passed.
An initial sandboxed test attempt could not bind local fake-server sockets and was stopped; the
approved rerun passed. Those repository checks exclude spike source, so manual live probes plus
JavaScript/Python syntax checks and evidence-schema validation cover this harness.

Cleanup readback: private tmux server absent; all owned pane processes exited; hook listener and private
Codex app-server exited; private Codex socket absent; no owned Electron process remained. The interrupted
native visual attempt may leave its Ghostty window displaying an exited command; no test process/client
remains behind it. No further native UI interaction was attempted after computer-use denied access.
