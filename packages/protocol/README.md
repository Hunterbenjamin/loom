# @loom/protocol

Zod schemas and inferred types for coordinator clients: windows and CLI. This package defines
frames and patch semantics; it opens no socket. [coordinator/server.ts](../../apps/coordinator/src/server.ts)
implements the server, and [client.ts](../../apps/coordinator/src/client.ts) the shared client.

## Transport

One JSON object per WebSocket text message. Size is checked before parsing; both incoming and
outgoing frames validate against [frames.ts](src/frames.ts). The client sends `hello` with version,
identity, token and subscriptions; the server returns `welcome`, snapshot, then patches. Tokens
travel in a frame or Authorization header, never in a URL. Invalid handshake/version frames close
with a typed error. Ping/pong uses the negotiated heartbeat; three misses disconnect a client.

## Snapshot and patches

[snapshot.ts](src/snapshot.ts) names entity collections and keys. [patch.ts](src/patch.ts) applies
ordered upserts/deletes. Sequence numbers are contiguous per connection, after subscription
filtering. Replayed older sequences are ignored; gaps require a fresh snapshot, never a partial
stream. A delete carries enough scope to determine which subscribers lose the row.

[subscriptions.ts](src/subscriptions.ts) owns scope/filter semantics for tasks, views, runs, diffs,
native panes, repository PRs and conversations. Repository/task-list metadata is small; selected
content follows subscriptions. [views.ts](src/views.ts) carries core-derived inbox attribution and
review/CI metadata, so renderers do not recreate workflow decisions.

## Commands

[commands.ts](src/commands.ts) is the command and acknowledgement catalog. Every request receives
one result or typed error. Human commands return their committed disposition according to
[instant-command semantics](../../docs/design/core.md#instant-human-commands); an accepted command
can still have pending external effects. Reconnect does not replay commands.

Command families cover task creation/edits and workflow, repository selection, terminal attach and
lifecycle, Main/chat, PR actions/content/review state, settings and daily briefs. A schema's presence
does not imply every target is implemented: task `fetch_diff` and task `save_review_state` return
`unavailable`; PR diffs and PR viewed state are supported.

Issue-targeted commands resolve canonical `t-…` IDs, case-insensitive repository keys and bare
numbers at the coordinator boundary. Unknown references return `unknown_task`; ambiguity or foreign
repository references return `invalid_input`. Subscriptions use canonical IDs.

## Source map

- [entities.ts](src/entities.ts), [ids.ts](src/ids.ts): validated domain projections and branded IDs.
- [pull-requests.ts](src/pull-requests.ts): PR lists, details, immutable ranges and reviewed files.
- [briefs.ts](src/briefs.ts), [settings.ts](src/settings.ts): research and preference contracts.
- [views.ts](src/views.ts): native panes, conversation rows and derived task-list metadata.

Native pane identity includes host generation and pane ID. Public attach targets omit private run
credentials. UI close versus detach behavior is documented in [Workbench](../../docs/design/ui.md#workbench).
Owner/cache semantics belong to [architecture](../../docs/architecture.md), not a second schema here.

Colocated tests verify JSON round trips, core type equality, ordered patch replay, gap detection
and scope filtering. Desktop fixture tests parse generated snapshots with these same schemas.

## Entity schemas

Core owns entity types and closed value lists. [entities.ts](src/entities.ts) owns their zod
shapes, including artifact metadata and stored task context. The schema factory defines fields
once and exports strict wire schemas plus `storedEntities` for persistence. Store and MCP derive
their entity schemas from these exports; type-equality tests check them against core.

The storage policy preserves historical reads: objects strip unknown keys, IDs need only be
nonempty, paths may be noncanonical, task summaries default to null, and budgets may be zero or
fractional. Stored hashes still require their full hex format; stored review caps and location/plan
versions remain positive. Wire checks retain their existing strictness, including attention
invariants. Stored message reads still omit the derived `deliveryReason`. These boundary rules
are intentional; sharing a field must not silently tighten old-row validation or weaken wire checks.
