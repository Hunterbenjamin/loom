# Claude Code adapter

Implements `ClaudeAdapter` from [`packages/core/src/adapters.ts`](../../core/src/adapters.ts)
against Claude Code 2.1.269, following [spike 02](../../../spikes/02-claude-hooks/FINDINGS.md).

```ts
const adapter = await createClaudeAdapter({
  mcpServer: { command: "loom", args: ["mcp", "--run", runId] },
});
await adapter.writeSettings(settingsPath); // + settings.mcp.json beside it
const args = adapter.interactiveArgs({ sessionId, resume: false, model, settingsPath });
```

## Who owns what

- **`claude agents --json` owns live status.** It is the only source that sees an Esc interrupt,
  a crash, or the moment a permission is approved; none of those fire a hook. Unknown `status` and
  `kind` values map to `other` with the raw string kept, because the enum is undocumented.
- **Hooks are hints and detail.** The receiver binds loopback, answers every request `200 {}`, and
  appends a receipt; `hookSummary` folds a session's receipts on demand. `HookLog` is the
  persistence seam: `MemoryHookLog` here, the design's `claude_hooks` table in `packages/store`.
- **Loom owns the session ID and the settings file.** Both are chosen before launch, and a retry
  resumes the same ID (principle 7). Nothing is ever written to `~/.claude/settings.json`.

## Timing worth knowing

`claude agents --json` took up to about five seconds to list a relaunched session (spike 05), so
the design's `unknownGraceMs` must stay above that; the placeholder of 60 s does. HTTP hooks are
registered with `timeout: 1` because a hung coordinator otherwise adds its timeout to every hook.

## Tests

`pnpm test` posts spike 02's recorded payloads to a real receiver and folds them; no agent runs.
`LOOM_REAL_PROVIDERS=1 pnpm vitest run packages/adapters/claude/src/real.test.ts` starts one
headless session on `haiku` in its own temporary directory. Fixtures are in `src/fixtures/`.
