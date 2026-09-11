# Spikes

Throwaway experiments. Each one answers an open integration question in `docs/architecture.md` before we build on it.

| # | Question | Agent | Depends on |
|---|---|---|---|
| 01 | Can a Codex TUI and a second client share one live app-server thread? | codex | — |
| 02 | Do Claude Code hooks give reliable status and task correlation? Does `herdr agent prompt` deliver reliably? | claude | — |
| 03 | Does `herdr agent attach` work in a terminal embedded in Electron (xterm.js vs ghostty-web)? | claude | — |
| 04 | Does `@pierre/diffs` handle large diffs and review annotations? | codex | — |
| 05 | What survives each kind of restart, and how do we recover? | claude | 01 and 02 merged |

## Launching

Run these from a shell pane inside Herdr, in this repo:

```sh
scripts/spike.sh 01-codex-shared-thread codex
scripts/spike.sh 02-claude-hooks claude
scripts/spike.sh 03-embedded-terminal claude
scripts/spike.sh 04-pierre-diffs codex
```

For each spike, the script:
1. creates a worktree on branch `spike/<id>`;
2. opens it as a Herdr workspace;
3. starts the agent there;
4. gives the agent its brief.

Approve or answer the agents' prompts in Herdr as they come up.

## Rules for every spike

1. **Timebox.** It starts at your first experiment, and time spent waiting for a human's approval doesn't
   count. Stop when it runs out, and report what you have.
2. **Isolation.**
   - Put throwaway repos and data under `$TMPDIR/loom-spike-<id>/`.
   - Create panes only in your own Herdr workspace.
   - Never read, type into or close panes, agents, threads or sessions you didn't create.
   - For Codex, use a private app-server: `codex app-server --listen unix://$TMPDIR/loom-spike-<id>/codex.sock`.
     Never stop, restart or reconfigure the shared daemon (`codex app-server daemon …`).
   - Never edit global config. Use `claude --settings <file>`, `codex -c key=value`, and environment variables.
3. **Cost.** Keep test prompts trivial. Use the cheapest model: Claude `--model haiku`; for Codex, the
   smallest model it lists, passed with `-c model="…"`.
4. **Code stays in `spikes/<id>/`.** It's reference material and is never imported by packages. Spikes sit
   outside the pnpm workspace, so install their dependencies with `npm install` inside the spike directory.
5. **Versions.** Record the version of every tool you use.
6. **Evidence over opinion.** Back every answer with a command you ran and its trimmed output. Remove tokens and
   email addresses.
7. **Finish.**
   1. Write `spikes/<id>/FINDINGS.md` from the template below and commit it.
   2. Push branch `spike/<id>`.
   3. Open a draft PR titled `spike <id>: <question>`, with the Summary table in the body.
   4. Stop and report.

## FINDINGS.md template

```markdown
# Spike <id>: <question>

Versions: <tool versions>

## Summary
| Question | Result (works / works with caveats / doesn't) | One-line answer |
|---|---|---|

## Evidence
For each question: what you ran, what happened (trimmed output), and how many times.

## Implications for Loom
Concrete changes to docs/architecture.md or to the adapter design.

## Open questions

## How to rerun
```
