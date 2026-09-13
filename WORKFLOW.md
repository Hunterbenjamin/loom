# Loom workflow commands

Each `##` heading with a fenced block is one command Loom may run or approve for an agent
(`apps/coordinator/src/workflow.ts`). `setup` runs in every new worktree before an agent starts.

## setup

```sh
pnpm install --frozen-lockfile --prefer-offline
```

## test

```sh
pnpm test
```

## lint

```sh
pnpm lint
```

## typecheck

```sh
pnpm typecheck
```
