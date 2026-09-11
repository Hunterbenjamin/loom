# Spike 04: Diff review with @pierre/diffs

**Agent:** codex · **Timebox:** about 3 hours · **Depends on:** nothing. Read `spikes/README.md` first.

## Why

The review screen is where the human decides whether to merge. It has to stay fast on big PRs, and it has to
show agent findings, human comments and CI annotations inline.

## Setup

- **Test page:** a Vite + React page in this directory. It will run in Electron's Chromium later; a browser is fine for now.
- **Real diffs:** clone a mid-size open-source repo into `$TMPDIR/loom-spike-04/` and produce:
  - about 50 files and 2k changed lines;
  - about 300 files and 20k changed lines;
  - a single 10k-line file;
  - a lockfile change.

  Also try `gh pr diff <n>` output from a public repo, and a diff between two commits.

## Questions

1. **Performance.** For each diff size, measure time to first paint, scroll smoothness and memory, with and
   without the worker pool. Where does it break down?
2. **Annotations.**
   - Render 50 and then 200 finding cards: custom React components with severity, a status chip, a reply thread
     and a resolve button.
   - Select lines to start a new comment.
   - What happens to annotations when the diff is replaced by a newer version (a new commit)?
   - What should Loom store to anchor an annotation (file, side, line, content hash)?
3. **Built in, or build our own?** Split and unified views, collapsing unchanged regions, a file list and jumping
   between files, "viewed" state, keyboard navigation.
4. **Inputs.** Multi-file patches from git and from GitHub, and old/new file contents. Does anything fail to parse?
5. **Theming.** A Linear-like dark and light theme, with a custom font.

Only if Pierre fails a requirement, compare it briefly with `@git-diff-view/react`.

## Deliverable

`FINDINGS.md`, containing:
- a table of the performance numbers;
- the proposal for anchoring annotations;
- a list of gaps;
- a recommendation.
