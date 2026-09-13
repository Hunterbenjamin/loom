# @loom/protocol

The typed API between the coordinator and its windows: a full snapshot on connect, then ordered
patches, with per-client subscriptions so a window showing one task isn't sent every diff of every
task. Schemas are zod; the types are inferred from them, so there is one definition of each shape
and it is the one that validates. This package defines the contract and the client-side patch
semantics. It builds no server and opens no socket.

Designed for several windows at once from the start (`docs/design/ui.md`): a Tracker and a Workbench
side by side, plus a CLI, all clients of the same snapshot.

## Transport

One WebSocket per client on the coordinator's bind address, loopback by default and configurable, so
a phone inbox or an always-on host can follow later without a rewrite.

- **Framing.** One JSON object per WebSocket text message, UTF-8. No framing of our own, no batching
  across messages, no binary messages. A message that fails `clientFrame` / `serverFrame` is a
  protocol error, never a partial read. `MAX_FRAME_BYTES` is checked before parsing.
- **Handshake.** The client sends `hello` with the protocol version, its token and what it wants to
  watch; the coordinator answers `welcome`, then a `snapshot`, then patches. The token goes in that
  frame or in an `Authorization: Bearer` header, never in the URL, because query strings reach logs
  and `ps`. Any other frame first is `not_authenticated`; a second `hello` is
  `already_authenticated`. Failures send one `error` frame and close with a code from `CLOSE`.
- **Heartbeat.** `ping` / `pong` at `welcome.heartbeatMs`. A client that misses three is dropped; it
  reconnects and takes a fresh snapshot, which costs nothing because it holds no durable state.

```ts
import {
  applyPatch,
  decodeServerFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  stateFromSnapshot,
} from "@loom/protocol";

socket.send(
  encodeFrame({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    token,
    client: { id: windowId, kind: "tracker", name: "Loom", version },
    subscriptions: [{ kind: "views", views: ["needs_you"], repoIds: null }],
  }),
);

socket.onmessage = (event) => {
  const decoded = decodeServerFrame(event.data as string);
  if (!decoded.ok) return fail(decoded.error);
  const frame = decoded.frame;
  if (frame.type === "snapshot") client = stateFromSnapshot(frame, frame.body);
  if (frame.type === "patch" && client) {
    const applied = applyPatch(client, frame);
    // A gap means frames were lost. Ask for a snapshot; never apply half a stream.
    if (!applied.ok && applied.reason === "sequence_gap") resync(applied.expected);
  }
};
```

## Snapshot and patches

`snapshotBody` holds one collection per entity; `patchBody` carries ordered upserts and deletes of
rows of those same collections, keyed by the field `collections` names. There is no generic JSON
patch: a per-entity upsert is small enough, and it can be validated.

- **Sequence numbers are per connection and contiguous.** A patch applies only when its `seq` is
  exactly the next one, so a gap always means loss. A coordinator-wide counter would leave holes
  wherever a subscription filtered something out, and a client could not tell those from dropped
  frames. An earlier `seq` is a replay and is ignored.
- **The only recovery from a gap is a fresh snapshot.** `resync` asks for one; the snapshot names the
  `seq` the stream continues from.
- **A delete carries its task**, because a key alone cannot be matched against a client's
  subscriptions. A `task` delete means "no longer yours": the task was removed, or it left the views
  this client subscribed to.

## Subscriptions

Every client receives the repo list and its task list. Everything larger follows a subscription:
`{ kind: "task" }` for one task's detail, `{ kind: "diff" }` for one task's changed files in one
range, `{ kind: "run" }` for a terminal panel's attach target and pane state. `taskInView`,
`scopeOf`, `inScope` and `filterChanges` are the shared definition of "in scope", so a window and
the coordinator cannot disagree about it.

## Commands

`{ kind: "human" }` wraps `HumanCommand` from `@loom/core` for one task: the coordinator validates
it, records it as an input and acknowledges it with that input ID. It has not run yet — reconcile
decides what happens, and the result arrives as patches and a transition (principle 3). The UI-only
requests are `open_attach_session`, `fetch_diff` and `save_review_state`. Every request gets exactly
one `ack`: an `ackResult` or a typed `protocolError` whose codes include `McpErrorCode`, so a
rejection reads the same whether it came from a window or an agent.

## What the protocol adds over `@loom/core`'s entities

Each of these is a gap the fixture shell found (PR #18) and `docs/design/ui.md` asked for:

| View | Why |
|---|---|
| `Attention.reasonSince` (in core) | An inbox sorts by how long *each* reason has waited, not by the set |
| `taskMessage`, `taskTestResults` | The task key the UI joins on, so nobody parses a run ID |
| `runTarget` | Where a human attaches, and what the pane host says about the pane |
| `taskChanges` / `changedFile` | Path, previous path, status, binary, counts, stable file ID and a monotonic version, from Git metadata: Pierre ignores a changed file whose version didn't change |
| `reviewRange` | Whether the whole branch or only the changes since the last reviewed head is under review |
| `commentThread` | Review is a conversation, and it has to survive a restart |
| `reviewState` | Viewed files, the current file and unsent drafts, all coordinator-owned |

`ids.ts` is the one place a string becomes a branded `@loom/core` ID. Consumers parse; they never
cast.

## Tests

`src/*.test.ts`. Every schema round-trips through JSON; a type-level test keeps each mirror equal to
the core type it mirrors; a fake client applies a snapshot and a patch stream and ends where a fresh
snapshot would; a sequence gap is detected and applies nothing; subscriptions filter. The shell's
fixture store is converted to a protocol snapshot and parsed with the real schemas in
`apps/desktop/src/renderer/fixtures/protocol.test.ts`, so the fixtures and the contract can't drift.

## Tracker inbox (protocol version 2)

The `inbox` collection is small task-list metadata keyed by task ID: `reasonRuns` contains the runs
attributed by core's attention derivation, `planVersion` identifies the plan an approval names, and
`reviewedHead` is the last reviewed SHA (never an inferred current head). It reaches every window,
so an inbox and title badge need no subscription per task. Full plans, questions and Activity still
follow the selected task subscription. Reasons and `reasonSince` remain on the task; renderers do
not derive them. Several runs may contribute to a single reason, but the inbox still has one row
per task/reason. Version 2 explicitly rejects old clients rather than sending them an unknown
collection. Pane attach targets already existed; their public environment is now empty, since an
attach client does not need the run recipe's MCP credentials.

### Native panes

Subscribe with `{kind: "panes"}` for `panes` and `paneInventory` snapshot arrays and keyed `pane` /
`pane_inventory` patches. The physical key is JSON encoding of `[hostGeneration, paneId]`. Labels,
nullable task/run links, attention and status are coordinator-derived; command, title, native IDs,
start cwd and dead/exit state come from the host. Counts are session-group client counts. Unavailable
observations retain rows and publish health, including for an empty inventory; recovery and removals
are semantic patches. No observation timestamp churn is emitted.

`open_pane_session` accepts only `target: {hostGeneration, sessionName, windowId, paneId}` and returns
an `attach_session` with `identity: "pane"`, the validated target, attach argv and current pane state.
Run and Main requests retain their existing forms. `create_scratch` accepts `taskId` and a UUID `key`;
the coordinator resolves cwd/session and returns `scratch_created` with the published pane. Clients
must not replay scratch commands on reconnect. A terminal detaches when closed; it does not close its
underlying pane.
