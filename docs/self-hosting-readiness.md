# Self-hosting readiness

Loom builds itself only once the pipeline has earned it. This file is the bar and the evidence.
The rule that puts it in force is "Until then: two tracks" in `docs/build-plan.md`.

## Exit checklist

Every line must hold on the dev instance against `loom-sandbox`, with no manual poke: no
answering a pane by hand, no `loom task retry`, no coordinator restart other than the one the
recovery line asks for.

- [ ] Five consecutive small tasks (`--small`) go from `todo` to `done` in five minutes or less.
- [ ] Five consecutive normal tasks go through plan, implementation, review, one fix round,
      approval and merge.
- [ ] A coordinator restart mid-implementation recovers: the run resumes on its recorded session
      and the task reaches `done` without a retry.
- [ ] A PR merged on github.com, not through Loom, shows up as `done`.
- [ ] Three consecutive days of smoke runs with no runtime bug filed.

"Consecutive" resets on any failure. When every box is ticked, delete the two-tracks section
from the build plan and move Loom's own tasks back onto the prod instance.

## Smoke log

`scripts/smoke.sh` appends one line per run. Anything in the *notes* column that is a runtime
failure gets a task on the dev track, and the task id goes in the same cell.

| date | task | result | minutes | notes |
|------|------|--------|---------|-------|
