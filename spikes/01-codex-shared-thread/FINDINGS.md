# Spike 01-codex-shared-thread: Can a Codex TUI and a second client share one live app-server thread?

**Recommendation: concurrent attach on the same app-server, with caveats.** Use a handoff for a plain Codex session running in another runtime. Do not infer its live status from a second server's disk snapshot.

Experiment: 2026-09-11, 10:04–10:30 UTC (18:04–18:30 Asia/Makassar), within the approximately three-hour timebox. Documentation and verification followed. This is a bounded local experiment, not a production reliability guarantee.

Versions: macOS 26.2 (25C56); codex-cli **0.154.0**; Herdr client/server **0.9.0**, private protocol 22; Node **24.14.1**; npm **11.11.0**; pnpm **10.0.0**; git **2.51.2**; gh **2.90.0**; TypeScript **7.0.2**; tsx **4.23.13**; ws **8.21.3**; zod **4.6.2**; Biome **2.5.13**; Vitest **5.0.0**; Python **3.13.1**; zsh **5.9**; `/bin/sh` Bash **3.2.57**. macOS supplies the `ps`, `lsof`, and `strings` inspection utilities.

Model: **gpt-5.6-luna**, low effort, ordinary/default service tier. `model/list` described Luna as “Fast and affordable agentic coding model.” It was the inexpensive general-purpose choice from the advertised catalog; that endpoint does not supply prices or parameter counts, so this does not establish a measured price ranking against Spark. No successful prompt used a larger model. One deliberately invalid model name tested failure signaling.

## Summary

| Question | Result (works / works with caveats / doesn't) | One-line answer |
|---|---|---|
| Live TUI attach and input from both clients | works | History, live output, TUI input, client input, and steering share the same thread and active turn. |
| Command approvals | works with caveats | All subscribers receive the request; either side can answer; late subscribers receive pending requests; no timeout within 30 seconds. |
| Interrupt in either direction | works with caveats | Both sides see an interrupted turn, but the running shell command can continue. |
| Detach and reconnect | works | Turn survived TUI closure and five seconds with no subscribers; resume recovered current state and later completion. |
| Private server crash | works with caveats | Saved history recovers; unfinished turn becomes interrupted; pending command detail can be absent; a new turn succeeds. |
| Status mapping | works with caveats | Native status flags cover working/approval/input/idle/error; rate-limit events are observable, but actual quota exhaustion was not induced. |
| Plain sessions started outside Loom | works with caveats | Disk discovery/read works; the private server does not own the plain TUI's live execution or report its status reliably. |

## Evidence

Live experiment data lived under `$TMPDIR/loom-spike-01/`; call this `$SPIKE` below. The throwaway repo was `$SPIKE/repo`. A separate `$SPIKE/home` held Codex configuration, databases and sessions, with a symlink to existing CLI credentials; credential contents were never inspected. No global configuration was edited. Only test-created panes in the assigned Herdr workspace were controlled. The shared app-server daemon was not accessed, stopped, or reconfigured.

`client.ts` records every sent/received protocol envelope as redacted JSONL in `$SPIKE/logs`. `relay.ts` transparently records TUI traffic without initializing a client or answering requests itself. Initial live attach used the direct server socket; later TUI tests used the recording relay to the same server. `run.ts` retains the approval, detach, and crash drivers. Raw logs and generated bindings stay out of git; the trimmed outputs below are the reviewable record.

### Transport and initialization

Commands:

```sh
codex --version
herdr status server
codex app-server generate-ts --experimental --out generated
codex app-server --listen "unix://$SPIKE/codex.sock" -c model="gpt-5.6-luna"
```

The client sends `initialize` with `experimentalApi: true`, followed by `initialized`. The native TUI handshake was `GET /rpc HTTP/1.1`, `Host: localhost`, WebSocket version 13. Initial `ws` attempts failed; scoped diagnostics on the private server reported:

```text
failed to upgrade control socket websocket connection:
WebSocket protocol error: Missing, duplicated or incorrect header sec-websocket-extensions
```

The working connection is:

```ts
new WebSocket(`ws+unix://${socket}:/rpc`, {
  headers: { Host: "localhost" },
  perMessageDeflate: false,
});
```

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes Unix sockets as WebSocket transports and documents initialization and version-specific binding generation. The `/rpc` path and compression rejection above were verified against the installed binary, not assumed from documentation. The fake-server test locks in those transport options.

One attempt to resume a newly started thread **before its first turn** returned `-32600: no rollout found for thread id …`, even though `thread/start` had returned an ID and path. After a trivial first turn, resume succeeded. Persist the returned ID before starting work, but do not equate a returned rollout path with a durable, readable history.

### 1. Live attach and input

Primary thread: `01a08ff4-b43e-71d3-aae7-fa59a9070465`. `thread/start` returned the ID; the client wrote it to its owned-thread registry before `turn/start`.

```text
client turn/start: Reply exactly HISTORY_ONE. Do not use tools.
turn/completed: status=completed, text=HISTORY_ONE
client turn/start: Say LIVE_BEGIN, run sleep 40, then reply LIVE_END.
```

While the second turn was running:

```sh
CODEX_HOME="$SPIKE/home" codex resume "$THREAD" \
  --remote "unix://$SPIKE/codex.sock" -C "$SPIKE/repo" \
  -c model="gpt-5.6-luna" --no-alt-screen
```

TUI output, read from the test-created pane:

```text
› Reply exactly HISTORY_ONE. Do not use tools.
• HISTORY_ONE
› Say LIVE_BEGIN, then run sleep 40 ...
• LIVE_BEGIN
• Working ... 1 background terminal running
```

Client `turn/steer` used `expectedTurnId=01a08ff5-3952-7441-a4f2-b9a06d882865`, requesting `CLIENT_STEER`. The response returned that same turn ID; both clients later saw `CLIENT_STEER`.

TUI input initiated another turn, and client A received its user-message item and `CLIENT_STEER TUI_STEER` final answer. A separate, correctly timed mid-turn TUI submission via `herdr agent prompt <own-pane> ...` produced this recorded outbound message:

```json
{"method":"turn/steer","params":{"threadId":"01a08ff4-b43e-71d3-aae7-fa59a9070465","expectedTurnId":"01a08ffb-6be3-7440-882e-4a5784b24b7d","input":[{"type":"text","text":"After the sleep, include TUI_MIDTURN in the final reply.","text_elements":[]}]}}
```

Both sides saw `TUI_LIVE_END TUI_MIDTURN`. Direct `pane send-text` plus an immediate Enter initially left the text in the composer; that attempt was not counted as mid-turn steering. The ordered `agent prompt` submission was verified through provider events, not Herdr's status classification.

Counts: one explicit mid-turn direct attach, additional reconnects; one successful client steer, one successful TUI mid-turn steer, and turns initiated from each side. No sustained simultaneous-writer stress test.

### 2. Approvals

Prompts requested only harmless `printf APPROVAL_*` commands with `sandbox_permissions=require_escalated`. Thread/turn policy was `on-request`, `approvalsReviewer: user`. No execution-policy amendment was accepted.

```sh
node --import tsx run.ts approve "$THREAD"
node --import tsx run.ts tui "$THREAD"
node --import tsx run.ts decline "$THREAD"
node --import tsx run.ts hold "$THREAD"
```

Trimmed recorder/client evidence:

```text
10:17:57.121 TUI receive item/commandExecution/requestApproval id=2
10:17:57.146 driver sends result {decision:"accept"}, id=2
10:17:57.157 TUI receive serverRequest/resolved requestId=2
10:17:58.941 turn/completed completed; "It ran successfully."

10:18:27.944 driver receives request id=3
TUI: Would you like to run ... $ printf APPROVAL_TUI
10:18:30.248 TUI SEND {id:3,result:{decision:"accept"}}
10:18:30.249 TUI receive serverRequest/resolved requestId=3
10:18:31.478 driver completion; pending requests=[]
```

The TUI cleared its dialog after client approval. Its recorder emitted **no approval response** for request 2; the driver answered it. Client A and B logs also contain identical approval request IDs and resolution notifications. Request 4 was answered with `decline`; the command did not execute and the model stopped without retrying. (The schema accepts `decline`, although this request's advertised choices were accept, accept-with-rule, and cancel.)

Unanswered tests, twice: at 30 seconds and roughly 31 seconds after receipt, `thread/read` still returned `active` with `activeFlags:["waitingOnApproval"]`. Interrupting cleared the pending request and completed the turn as interrupted. This establishes **no timeout within the observed interval**, not an infinite wait guarantee.

On the second unanswered test, a newly connected client called `thread/resume` while approval was pending:

```text
lateSubscriber.status = {type:"active",activeFlags:["waitingOnApproval"]}
lateSubscriber.pending = [0]
```

It received the pending server request. Request IDs restarted at 0 after the crash/restart, so they are not globally durable identifiers.

Counts: five resolved command approvals (three TUI accepts, one driver accept, one driver decline); two bounded unanswered tests; one late-subscriber replay check. Only one TUI-answer case had a full protocol recorder; the earlier two were corroborated by observer events and the TUI display. Conflicting simultaneous answers were not raced.

### 3. Interrupt

One client interrupt and one TUI Esc, both during native `commandExecution` items:

```text
10:19:11.290 client sends turn/interrupt
10:19:11.299 client + TUI receive turn/completed status=interrupted
TUI: Conversation interrupted - tell the model what to do differently.

10:19:35.064 TUI sends turn/interrupt (after herdr pane send-keys <own-pane> esc)
10:19:35.088 client + TUI receive turn/completed status=interrupted
```

The shell sleeps continued. Later `thread/read` retained `status: interrupted` for those turns but showed their command items as `completed`, `exitCode: 0`, duration approximately 45 seconds. The interrupted model turn and subprocess lifetime are separate facts.

### 4. Detach

One controlled successful run:

```sh
node --import tsx run.ts detach "$THREAD"
```

The driver creates its own TUI pane, starts a 45-second sleep, waits for the native command-start event, closes that pane, reads state, disconnects itself, then reconnects five seconds later. Earlier observer clients had already closed their sockets. The transparent relay closes its upstream connection when its TUI closes.

```text
10:22:18.096 beforeDetach: active; turn=01a08ffd-3d06-7b13-9e89-3cfc3c6a6e70
10:22:18.170 afterTuiClose: active
10:22:23.276 thread/resume after no subscribers: active; same turn inProgress
10:23:04.388 reconnected client receives turn/completed completed; DETACH_DONE
```

Resume included history/current turn state and subsequent command/completion events. It did not re-emit the already-seen `turn/started` notification to the reconnecting client. Reconciliation must hydrate the snapshot rather than require replay of every event. Completion entirely without reconnecting, and an unanswered approval with zero subscribers, remain untested.

### 5. Crash

One SIGKILL of the **private** app-server, guarded by the exact socket argument and the native process identity in its own pane:

```sh
LOOM_SPIKE_SERVER_PANE=<own-server-pane> \
  node --import tsx run.ts crash "$THREAD"
```

```text
10:27:37.842 beforeKill: active; turn=01a09002-00eb-7e13-8344-2f894305b3bc
10:27:38.850 socket=CLOSED; no turn/completed received
10:27:40.965 fresh server thread/read:
  thread.status=notLoaded; last turn.status=interrupted; completedAt=null
  saved items include user prompt and CRASH_BEGIN
10:27:41.265 thread/resume: idle; same last turn interrupted
10:27:47.014 new turn/completed: completed; RECOVERED
```

The native command-start event preceded SIGKILL, but that pending command item was absent from the fresh server's saved turn. A missing persisted command is not proof it never executed. Recovery restored recorded history; it did not continue the killed model turn or guarantee exact replay of side effects.

### 6. Status mapping

The following uses `thread/read` / `thread/resume` snapshots and native notifications. Agent run status remains independent from Loom's issue stage.

| Provider observation | Loom run status / attention | Verification |
|---|---|---|
| `thread/status/changed`: active with no waiting flags; `turn/started` inProgress | Working | Repeated live turns. |
| Active + `waitingOnApproval`; `item/commandExecution/requestApproval` | Blocked / human approval needed | Seven requests including the two holds. Preserve request ID until resolved. |
| Active + `waitingOnUserInput`; `item/tool/requestUserInput` | Blocked or working-with-attention, according to request blocking semantics / human input needed | One actual structured question; see below. |
| `serverRequest/resolved` | Clear that request; re-read status before deciding the run state | Approval, decline, interrupt, and question response observed. |
| Idle + turn completed | Idle | Repeated. |
| Turn interrupted | Idle/interrupted outcome after reconciliation | Both interrupt directions. Do not imply subprocesses stopped. |
| `error` with `willRetry:true` | Retrying/working; retain error details | Schema-backed proposal; not induced. |
| `error` with `willRetry:false`, turn failed, thread systemError | Failed / attention needed | One intentionally unsupported model request. |
| `account/rateLimits/updated` | Refresh `account/rateLimits/read`; update allowance and reset information | Actual updates and read succeeded; update receipt alone is not a blocked signal. |
| `rateLimitExceeded`, `usageLimitExceeded`, `serverOverloaded` or snapshot disallowing usage | Cooling down/blocked when provider evidence warrants it; schedule from known reset or backoff | Proposed from generated error/snapshot types; actual quota exhaustion/429 was not induced. |
| Socket closed, or thread notLoaded on this server | Unknown/unloaded until owner reconciliation | Crash, idle unloading, and external plain TUI. Never equate this alone with failed or idle. |

Structured input needed `thread/start.config["features.default_mode_request_user_input"]=true` for the successful default-mode case. An earlier plan-mode prompt without this override did not produce the tool request. Successful native evidence:

```text
10:24:28.305 activeFlags=[waitingOnUserInput]
10:24:28.306 item/tool/requestUserInput id=6
  question id=fixture_label; options=Alpha,Beta
  isBlocking=false; autoResolutionMs=null
10:24:53.359 client answers {answers:{fixture_label:{answers:["Beta"]}}}
               serverRequest/resolved requestId=6
10:24:55.533 turn/completed completed; text=Beta
```

The request was nonblocking on the wire despite the model waiting for our answer. Preserve `isBlocking`, waiting flags, and attention separately; do not infer blocking semantics solely from the request's existence.

Failure probe: a turn requesting `loom-spike-nonexistent-model` produced an upstream unsupported-model 400, `codexErrorInfo: other`, `willRetry:false`, `thread.status:systemError`, and `turn.status:failed` in about one second.

`account/rateLimits/read` returned `ordinaryUsageAllowed`, per-limit snapshots, usage windows and reset timestamps. Client A recorded 25 `account/rateLimits/updated` events during the experiment. Generated `AccountRateLimitsUpdatedNotification.ts` describes sparse updates; refreshing the snapshot fits Loom's reconciliation rule. No reset credits or account settings were changed.

### 7. Sessions started outside Loom

Started plain Codex in a new test-created pane, with the **same isolated home**, without `--remote`:

```sh
CODEX_HOME="$SPIKE/home" codex -C "$SPIKE/repo" \
  -c model="gpt-5.6-luna" -c model_reasoning_effort="low" --no-alt-screen
herdr agent prompt <own-plain-pane> 'Say PLAIN_BEGIN, run sleep 35, then reply PLAIN_DONE ...'
```

Observed process tree via `herdr pane process-info`, `pgrep -P <own-pid>`, `ps` on those returned child PIDs, and `lsof -a -p <own-pid> -U`: the TUI binary and its Node/code-mode helper processes, with no separate app-server daemon or named control socket under the isolated home. Alongside the ownership results below, this supports an **embedded-runtime** conclusion for this configuration. It does not audit the user's shared daemon or every possible CLI configuration.

Private server read-only calls, filtered to the throwaway cwd:

```text
thread/list(useStateDbOnly=true):
  id=01a08fff-b739-7831-aa29-a85212def35b
  source=cli; originator=codex-tui; status=notLoaded
thread/loaded/list: does not include that ID
thread/read(includeTurns=true), while plain TUI is active:
  status=notLoaded; unfinished turn.status=interrupted; completedAt=null
```

Repeated with a 25-second second turn: the disk read again said interrupted while the TUI showed `Working (1s)`. The first completed turn was preserved. Both turns subsequently finished normally as `PLAIN_DONE` and `PLAIN_SECOND_DONE`; the reads did not interrupt them. No `thread/resume`, steering, or interruption was sent to this external live thread through the private server. Only the plain TUI controlled it.

Counts: two disk reads during live plain turns, discovery and loaded-list comparisons, plus completion observation. Plain startup is intentionally the brief's outside-Loom case: its generated ID was discovered after startup and recorded before targeted reads, rather than preallocated by the coordinator.

## Implications for Loom

- **Use concurrent attach for coordinator-owned Codex threads on the same server.** `docs/architecture.md` now replaces the exclusive Codex handoff assumption; Claude's separate assumption remains unchanged. No ownership principle was changed.
- Persist thread identity before the first turn, then establish durable history. Subscribe with resume, hydrate snapshots, and treat events as reconciliation hints. Use paginated history APIs for production-scale transcripts; this small client uses full history for inspection.
- Keep one coherent human-approval experience, but accept that both connected clients can answer. Clear stale prompts on resolution and namespace request IDs by server generation. Test first-answer races before shipping.
- Distinguish model-turn interruption, background command execution, connection loss, and disk-only recovery. Reconcile side effects before retrying commands after a crash.
- Discover plain sessions by canonical worktree path, but keep live ownership explicit. `/var/...` and `/private/var/...` were both returned for the same macOS fixture, so normalize paths before joining task/session records.
- Treat external runtime status as unknown until an authoritative live channel is available. An unfinished disk transcript can look interrupted while its owner is still running.

## Open questions

- Concurrent conflicting approval replies, double-submission races, stale steer IDs, and multi-client configuration override arbitration.
- Approval timeout beyond 31 seconds and approvals after all subscribers disappear.
- End-to-end completion with no subscriber returning, and long reconnect delays.
- File-change and permission approvals; actual retryable failures and rate-limit exhaustion.
- Whether the new-thread pre-first-turn resume limitation depends on history mode/version; durable allocation requires a production contract.
- Recovery across more command types, pending approvals, and restart modes belongs to spike 05. No claim that interrupted/crashed commands are safely retryable.
- Shared-daemon discovery was intentionally not tested: all read-only discovery used the isolated shared data directory and only test-created sessions.

## How to rerun

Run from this spike directory, inside the assigned Herdr workspace (`HERDR_ENV=1`). Use the installed versions above for a comparable result. Do not point the fixture at a real project or the shared daemon.

```sh
npm ci
npm run generate
export LOOM_SPIKE_ROOT="$(node -p 'require("node:os").tmpdir()')/loom-spike-01"
sh setup.sh                 # refuses to overwrite an existing experiment
export LOOM_REAL_PROVIDERS=1
```

If a prior experiment occupies that path, choose a fresh temporary parent for `LOOM_SPIKE_ROOT`, retaining the final `loom-spike-01` directory name. Do not delete unrelated sessions. `setup.sh` creates the repo/config/server script and only references existing CLI credentials; it does not edit global configuration.

Create the private server pane:

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$LOOM_SPIKE_ROOT/repo" \
  --label spike-01-server --no-focus
# Use the returned root_pane.pane_id, never a guessed/focused pane:
herdr pane run <returned-pane> "sh '$LOOM_SPIKE_ROOT/server.sh'"
node --import tsx client.ts a
```

Stdin is JSON, one command per line:

```json
{"cmd":"models"}
{"cmd":"start","options":{"developerInstructions":"Only operate in this throwaway repo. Do not spawn agents. Keep replies brief."}}
{"cmd":"turn","text":"Reply HISTORY_ONE. No tools."}
{"cmd":"turn","text":"Say LIVE_BEGIN, run sleep 45 and wait, then reply LIVE_END."}
{"cmd":"steer","text":"Reply CLIENT_STEER instead."}
{"cmd":"pending"}
{"cmd":"approve","requestId":0}
{"cmd":"decline","requestId":1}
{"cmd":"interrupt"}
{"cmd":"read"}
{"cmd":"limits"}
```

Use actual request/turn IDs from the logs; the examples are not an approval script. `events` prints recorded notifications, `pending` shows unresolved requests, `resume` accepts an owned `threadId`, and `quit` disconnects. The client refuses targeted access to threads absent from `$LOOM_SPIKE_ROOT/owned-threads.json`.

Create another **own** pane and run the direct TUI command from evidence section 1. Accept a trust prompt only for the fixture you created, and verify the TUI displays its history before counting the attach. For recording TUI traffic, first run `node --import tsx relay.ts`, then use `--remote unix://$LOOM_SPIKE_ROOT/tui.sock`. Leave the relay running for `detach`.

After the first history turn, the scripted cases are:

```sh
node --import tsx run.ts approve "$THREAD"
node --import tsx run.ts tui "$THREAD"       # answer from the attached test TUI
node --import tsx run.ts decline "$THREAD"
node --import tsx run.ts hold "$THREAD"      # no TUI on this thread; no manual answers
node --import tsx run.ts detach "$THREAD"    # close other subscribers first
LOOM_SPIKE_SERVER_PANE=<own-server-pane> node --import tsx run.ts crash "$THREAD"
```

The crash driver checks the exact private socket in the server process argv before SIGKILL. All live drivers require `LOOM_REAL_PROVIDERS=1`. The relay and driver print/write redacted evidence; automated tests never start a real agent. Clean up only the panes and processes created for this experiment, after pending turns settle.

Verification commands:

```sh
npm test
npm run lint
npm run typecheck
sh -n setup.sh
# From repository root:
pnpm test
pnpm lint
pnpm typecheck
```

The spike's offline tests cover malformed protocol messages, secret/email redaction, the Unix WebSocket handshake, pending-request cleanup, response validation and disconnection. Root tests currently have no product packages to exercise; the spike is deliberately outside the pnpm workspace.

Final results: spike tests **3/3 passed**, spike lint and strict typecheck passed, shell syntax passed; root `pnpm test`, `pnpm lint`, and `pnpm typecheck` all exited 0 (no product test files/packages yet). Only test-created panes, clients, and recorders were stopped; the temporary credential symlink was removed without modifying its target.
