# Phase 2: shared rules for every adapter brief

Each Phase 2 brief builds one package against the contracts on `main`. Read this file first, then
your own brief. **Timebox:** about 3 hours, counted from your first commit; time waiting for a human's
approval doesn't count.

## The contract

- The interface you implement is in [`packages/core/src/adapters.ts`](../../packages/core/src/adapters.ts).
  The observation shapes you must produce are in `observations.ts`, and the meaning of every field,
  including who supplies it, is in [`docs/design/core.md`](../design/core.md) §5.2 and §6.
- **Don't change `packages/core`**, with one exception: you may extend *your own adapter's interface*
  in `adapters.ts` when the design requires something it lacks (for example, a resumability check).
  List every such change in the PR under "Contract changes", one line each, with why.
- Validate every external input with zod at the boundary: CLI JSON, hook payloads, protocol messages,
  socket responses. Core never sees a raw string.
- No decision from terminal text, and never from Herdr's status. `docs/architecture.md`, "Agent
  integration", has the rules and the spike evidence behind them.

## Tests

- Unit tests run against fakes and recorded fixtures. They never start a real agent, touch the user's
  main Herdr server, the shared Codex daemon, or global config.
- Real-provider tests are opt-in with `LOOM_REAL_PROVIDERS=1`, use the cheapest model, and are skipped
  otherwise. For Herdr they use a private named session; for Codex a private `codex app-server`
  socket, as the spikes did.
- Record the fixtures you use (trimmed real output with tokens and emails removed) beside the tests,
  so the next person can see what the real tool actually returned.

## Package shape

```
packages/adapters/<name>/
  package.json        @loom/adapter-<name>, private, ESM, typecheck script
  tsconfig.json       extends ../../../tsconfig.base.json
  src/index.ts        the adapter factory and its exports
  src/*.test.ts       unit tests
  src/fixtures/       recorded output
```

Runtime dependencies only for what your brief names. Keep modules small.

## Deliverable

A PR titled as your brief says, containing the package and its tests, plus a description with:
- **Contract changes** (see above), or "none";
- **What the real tool actually does** where it differed from the docs or the spikes; this feeds the
  design;
- how you tested it, including whether you ran the real-provider tests.

Run `pnpm test`, `pnpm lint` and `pnpm typecheck` from the repo root before opening the PR. Open the
PR and stop. Don't merge.
