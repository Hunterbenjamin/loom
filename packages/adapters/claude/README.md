# Claude Code adapter

Implements [ClaudeAdapter](../../core/src/adapters.ts) using the CLI, per-session hooks and Agent
SDK. [index.ts](src/index.ts) exports `createClaudeAdapter`; pass the coordinator's MCP server
entry and durable hook log. `writeSettings` writes hook settings plus a sibling MCP configuration.
[Architecture](../../../docs/architecture.md#agent-integration) owns session and delivery rules.

## Source map

- [agents.ts](src/agents.ts): native `claude agents --json` reads and validation.
- [hooks.ts](src/hooks.ts), [receiver.ts](src/receiver.ts): hook receipts and folding.
- [settings.ts](src/settings.ts): per-session hook/MCP configuration; no global config edits.
- [headless.ts](src/headless.ts): SDK launches, resume and role tool restrictions.
- [transcript.ts](src/transcript.ts): provider-owned conversation and token usage reads.
- [brief-research.ts](src/brief-research.ts): bounded web-only daily-brief sessions.

Native status enums may add values: unknown values retain their raw text. Hook receipts provide
detail rather than replacing session status. `MemoryHookLog` serves fixtures; the
[store hook log](../../store/src/hooks.ts) supplies durability. Session listings may lag a relaunch;
recovery timing is configured in the coordinator rather than inferred from a missing entry.

Tests use [recorded payloads](src/fixtures/README.md), a local hook receiver and fake SDK responses.
`LOOM_REAL_PROVIDERS=1 pnpm exec vitest run packages/adapters/claude/src/real.test.ts` opts into one
Haiku session in a temporary directory. Normal tests launch no real agents.
