# Spike 04-pierre-diffs: Does Pierre handle large diffs and review annotations?

Recommendation: **use `@pierre/diffs` 1.4.2 with `CodeView` virtualization and a worker pool**, with a Loom-owned review shell and annotation anchors. A quick first paint is insufficient: the 10,000-line stress file subsequently freezes the main thread during highlighting without workers. Pierre renders numeric annotation locations; it does not track their meaning across commits.

Timebox: about three hours; experiments/checks ran 2026-09-11, 09:59–10:44 UTC (about 45 minutes). Reference code stays in this spike directory; fixture repos/data and measurements use `$TMPDIR/loom-spike-04/`. Browsers are isolated and closed after each run. No real coding agents, shared daemons, global configuration, or product packages were changed.

Isolation correction: the measurement runs used Playwright's automatically removed profiles directly under the system temporary directory. The checked-in runners now redirect those profiles into spike scratch as well; the final interaction run verifies that path. Fixture repos and saved data always used the prescribed spike directory.

Versions: Pierre 1.4.2; Shiki 4.4.3; React/React DOM 19.2.4; Vite 7.3.6; React Vite plugin 5.2.0; TypeScript 5.9.3; Zod 4.3.6; Playwright 1.58.2; Chrome 153.0.8010.36; Inter/JetBrains Mono variable fonts 5.2.8; fallback `@git-diff-view/react` and core 0.1.7. Final runner: Node 24.14.1, npm 11.11.0; initial shell also reported Node 23.6.0/npm 10.9.2. Git 2.51.2, GitHub CLI 2.90.0, pnpm 10.0.0, Python 3.13.1 (one text edit). Repository checks: Vitest 5.0.0, Biome 2.5.13, TypeScript 7.0.2. All npm resolutions are locked in `package-lock.json`.

## Summary

| Question | Result (works / works with caveats / doesn't) | One-line answer |
|---|---|---|
| Large diff performance | works with caveats | Use CodeView and workers; main-thread highlighting can stall despite a fast first paint. |
| 50/200 interactive finding cards | works | Custom severity, status, replies and resolve controls render through React annotation slots. |
| Select lines to comment | works | Drag the line-number gutter; the host receives file ID, side and line range. |
| Annotation survival after a new commit | works with caveats | Bump item versions and reanchor in Loom; unchanged numeric positions silently point at different code. |
| Common review UI | works with caveats | Views, context expansion and virtualized jumps are primitives; file list, viewed state and review shortcuts belong to Loom. |
| Git/GitHub patches and old/new contents | works with caveats | Normal patches work; quoted Unicode names, binary presentation and full-context loading need adapter handling. |
| Dark/light theme and custom font | works | Both themes and the bundled JetBrains Mono font render correctly, including slotted React cards. |

## Evidence

### Fixture provenance and measurements

Cloned [vuejs/core](https://github.com/vuejs/core/tree/v3.5.21), tag `v3.5.21`, commit `4b6cb1f52a0f6c5af2a0114b70000e23028eed15`, with depth two. The parent is `5d75a170c8d23acd11ef2513173d4cbc4d0b54de`.

```sh
git clone --depth 2 --branch v3.5.21 https://github.com/vuejs/core.git "$TMPDIR/loom-spike-04/vue-core"
gh pr diff 15477 --repo vuejs/core > "$TMPDIR/loom-spike-04/github-15477.patch"
npm run fixtures
node --experimental-strip-types scripts/inputs.ts
```

| Fixture | Files | Added / deleted | Provenance |
|---|---:|---:|---|
| `medium` | 50 | 1,000 / 1,000 | Mechanical edits distributed through real Vue TypeScript files. |
| `large` | 300 | 10,000 / 10,000 | Mechanical edits distributed through real Vue TypeScript files. |
| `single` | 1 | 10,000 / 10,000 | Exactly 10,000 lines concatenated from Vue source; every line modified. Deliberately adversarial, not an organic PR. |
| `lockfile` | 1 | 500 / 500 | The actual 6,716-line Vue pnpm lockfile with 500 integrity-line comments added. |
| `commits` | 13 | 38 / 12 | Unmodified `git diff HEAD~1 HEAD` in the clone. |
| `github` | 3 | 77 / 8 | Unmodified [public PR #15477](https://github.com/vuejs/core/pull/15477), via `gh pr diff`. |
| `edges` | 6 | 3 / 3 | Isolated Git tree diff: add, delete, pure rename, binary, Unicode filename, no final newline. |

Public PR head: `05c50f86b5fb9a95f30a4116e3bf4ab4d4bafa64`; merge commit: `51cce24b02a57ae2e70420f149a742aaf27746e6`. Its IDs were read with `gh pr view 15477 --repo vuejs/core --json number,baseRefOid,headRefOid,mergeCommit` and preserved in [the source record](evidence/github-source.json).

The generator ran twice with identical SHA-256 patch hashes. Parser file counts and inserted/deleted line counts match every fixture. Inputs and source contents remain temporary; only sanitized measurements and the fixture manifest are committed. The large patch is 2,469,083 bytes; the single-file patch is 752,363 bytes.

The final parser sweep checks each of the seven fixtures once, plus one CRLF and two malformed-input probes. Browser measurement groups contain 24 required-size runs, 24 annotation/layout runs, six renderer baselines, and ten input-path runs. Earlier smoke measurements are excluded from the tables.

### Performance

**Required sizes (three runs per setting).**

| Case | Workers | n | Parse ms | FCP ms | Diff paint proxy ms | Highlight ms | Scroll p95 ms | Worst long task ms | Peak browser RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| medium | 0 | 3/3 | 8.4 | 180 | 72 | 223 | 16.8 | 210 | 837–862 |
| medium | 4 | 3/3 | 7.6 | 168 | 127 | 279 | 16.8 | 0 | 870–904 |
| large | 0 | 3/3 | 44.8 | 368 | 98 | 302 | 16.8 | 207 | 896–956 |
| large | 4 | 3/3 | 44.4 | 344 | 139 | 288 | 16.8 | 55 | 912–941 |
| single | 0 | 3/3 | 13.2 | 156 | 112 | 11985 | 16.8 | 12497 | 919–949 |
| single | 4 | 3/3 | 12.0 | 128 | 95 | 6338 | 16.8 | 86 | 898–1044 |
| lockfile | 0 | 3/3 | 3.0 | 136 | 81 | 457 | 16.8 | 360 | 864–897 |
| lockfile | 4 | 3/3 | 2.5 | 96 | 96 | 313 | 16.8 | 0 | 925–941 |

**Annotations and unified layout (three runs per setting).**

| Case | Workers | n | Parse ms | FCP ms | Diff paint proxy ms | Highlight ms | Scroll p95 ms | Worst long task ms | Peak browser RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| medium / 50 cards | 0 | 3/3 | 7.4 | 152 | 79 | 218 | 16.8 | 114 | 869–889 |
| medium / 50 cards | 4 | 3/3 | 8.2 | 204 | 144 | 295 | 16.7 | 0 | 907–933 |
| medium / 200 cards | 0 | 3/3 | 6.8 | 116 | 53 | 175 | 16.8 | 116 | 889–942 |
| medium / 200 cards | 4 | 3/3 | 7.4 | 164 | 129 | 297 | 16.8 | 72 | 886–927 |
| large / 200 cards | 0 | 3/3 | 49.9 | 420 | 108 | 303 | 16.8 | 170 | 826–949 |
| large / 200 cards | 4 | 3/3 | 43.0 | 328 | 133 | 280 | 16.7 | 0 | 1018–1042 |
| large / unified | 0 | 3/3 | 44.3 | 348 | 91 | 284 | 16.8 | 169 | 917–969 |
| large / unified | 4 | 3/3 | 44.2 | 348 | 131 | 264 | 16.7 | 50 | 913–969 |

**Renderer baselines (one exploratory run per setting).**

| Case | Workers | n | Parse ms | FCP ms | Diff paint proxy ms | Highlight ms | Scroll p95 ms | Worst long task ms | Peak browser RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| large / plain | 0 | 1/1 | 44.9 | — | 76 | 16697 | 150.0 | 11986 | 1234–1234 |
| large / plain | 4 | 1/1 | 45.3 | 376 | 76 | 5338 | 1066.6 | 3987 | 1569–1569 |
| single / plain | 0 | 1/1 | 13.1 | — | 36 | 7191 | 33.3 | 6315 | 1392–1392 |
| single / plain | 4 | 1/1 | 11.5 | 116 | 34 | 7996 | 16.8 | 964 | 1577–1577 |
| large / virtualizer | 0 | 1/1 | 42.7 | 360 | 98 | 19710 | 16.8 | 19204 | 1129–1129 |
| large / virtualizer | 4 | 1/1 | 55.1 | 644 | 182 | 869 | 33.4 | 456 | 1269–1269 |

**Input paths (one exploratory run per setting).**

| Case | Workers | n | Parse ms | FCP ms | Diff paint proxy ms | Highlight ms | Scroll p95 ms | Worst long task ms | Peak browser RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| medium / contents | 0 | 1/1 | 39.0 | 204 | 86 | 412 | 16.8 | 1509 | 922–922 |
| medium / contents | 4 | 1/1 | 39.5 | 200 | 118 | 384 | 16.7 | 0 | 976–976 |
| single / contents | 0 | 1/1 | 7714.8 | 7912 | 220 | 12731 | 16.8 | 12396 | 810–810 |
| single / contents | 4 | 1/1 | 7554.1 | 7764 | 151 | 6840 | 16.8 | 7555 | 888–888 |
| github | 0 | 1/1 | 1.7 | 152 | 90 | 220 | 16.8 | 109 | 778–778 |
| github | 4 | 1/1 | 1.3 | 116 | 112 | 212 | 16.7 | 0 | 883–883 |
| commits | 0 | 1/1 | 1.2 | 120 | 69 | 119 | 16.7 | 0 | 847–847 |
| commits | 4 | 1/1 | 1.3 | 120 | 106 | 174 | 16.8 | 0 | 887–887 |
| edges | 0 | 1/1 | 1.2 | 124 | 60 | — | 16.7 | 0 | 829–829 |
| edges | 4 | 1/1 | 0.7 | 88 | 93 | — | 16.7 | 53 | 872–872 |


The important failures are the **post-paint main-thread freeze** on the 10,000-line file without workers and **DOM/layout saturation** when mounting all 300 `FileDiff` components without virtualization. The latter produced 150 ms / 1,066.6 ms scroll p95 without/with workers in the exploratory runs, respectively. Workers can deliver highlighted results faster than an enormous DOM can apply them. The plain 300-file run ended with roughly 1.58 million DOM nodes without workers and 2.40 million with workers (CDP counts can include detached nodes awaiting collection).

The standalone `Virtualizer` + mapped `FileDiff` baseline was also weaker than `CodeView` in this harness: a 19.2-second main-thread task without workers, and 33.4 ms scroll p95 with workers. These are single exploratory runs, not an exhaustive comparison of every possible wrapper/configuration. Prefer the dedicated list API that passed the repeated tests.

With `CodeView` and four workers, the same 10,000-line patch paints in roughly 95 ms from mount, completes first highlighting around 6.3 seconds, and avoids the 11.7–12.5 second main-thread task observed without workers. The final worker samples confirm that highlighting actually completed. Treat the short paint as a usable plaintext preview, not a promise that syntax colors are ready.

**Old/new contents have a separate blocking cost.** Computing the 10,000-line all-changed diff in the browser took 7.55–7.71 seconds before React mounted, even with a highlight worker pool. The equivalent precomputed Git patch parsed in about 12–13 ms. Use Git patches or compute content diffs off the renderer thread; the worker pool does not make `parseDiffFromFile` asynchronous.

Table values are medians except the worst observed long task and the range of per-run sampled peak RSS. `n` is completed/attempted runs. All 64 runs completed without page errors or the memory guard firing. A zero long-task value means no task of at least 50 ms was observed. `—` means unavailable/not applicable: Chrome had not reported FCP at the pre-scroll sample in two stressed plain-renderer cases, and plain-text edge fixtures have no syntax-highlight milestone. The paint proxy is not a pixel-level timestamp and can precede a paint report under stress.

Raw measurements: [required sizes](evidence/bench-core.jsonl), [annotations/layout](evidence/bench-annotations.jsonl), [renderer baselines](evidence/bench-baselines.jsonl), [input paths](evidence/bench-inputs.jsonl), [aggregated numbers](evidence/summary.json). Behavior evidence: [interactions](evidence/features.json), [parser sweep](evidence/inputs.json), [fallback comparison](evidence/comparison.json), [fixture hashes](evidence/fixtures.json).

Method: production Vite build, Chrome headless, Apple M3/8 GiB, macOS Darwin 25.2.0, 1440×1000 viewport, local fonts, split view unless specified. Each run starts a fresh browser profile and renderer; OS disk caches and other applications are not controlled. No CPU throttling. Worker runs use four workers and an AST cache limit of 100. There is no claim of an Electron or low-end Windows result.

The harness records browser FCP separately. “Diff paint” is a proxy: two animation frames after Pierre's post-render callback, measured from the React mount request after fetching and parsing the fixture. It excludes initial module/fixture loading; raw evidence also records the navigation-relative time. “Highlight” uses the same mount-time origin and detects actual token spans after a render, rather than assuming plaintext means completion. Parser time is separate; the old/new single-file case therefore pays roughly 7.6 seconds of computation before either mount-relative timer begins.

Scrolling starts after a nominal 1.5-second wait and moves 180 px each animation frame for six seconds. A main-thread stall can postpone that start. **The scrolling column therefore must be read together with the longest main-thread task**, which captures freezes during startup/highlighting too. Far-file jumping is tested separately after scrolling. Worker completion is awaited before the final sample, so slow background highlighting is not terminated early and mislabeled fast. Main-thread tasks under 50 ms are not reported by the Long Tasks API.

Memory is sampled every 500 ms using `SystemInfo.getProcessInfo` from the browser this script launched, followed by `ps` RSS for only those PIDs. Peak RSS is a sampled **sum for the entire isolated browser**, including browser/GPU/utility/renderer processes and workers; shared pages can be counted more than once. It is not private incremental renderer memory or an exact peak. Raw evidence also includes baseline RSS, main-realm JS heap and DOM counters. The harness closes its own browser at 1,800 MiB summed RSS to bound the experiment on this machine.

The required-size matrix has 24 final runs, including 12 healthy four-worker runs with no worker failures and empty queues at the final sample; no page errors. Per-run data is retained, including noise: one medium/no-worker run had a 33.3 ms scroll p95, and medium/large no-worker cases reached 200 ms individual frame gaps. For the single-file case, the main-realm heap was about 105–108 MiB without workers versus 36–55 MiB with workers; the latter excludes worker heaps and is not evidence of an equivalent reduction in total memory.

### Annotation behavior and revision replacement

```sh
node --experimental-strip-types scripts/features.ts
npm test
```

Final interaction run: 13 checks passed, no page errors. Six focused anchor tests passed. The initial pointer test dragged code text (native text selection); the corrected test drags the number gutter and receives a review-line range.

Trimmed evidence:

```text
50 findings; resolve + reply + unsaved draft survive unmount/remount
200 findings; 4 card nodes initially mounted; far-file finding-49 mounts
selected: additions, lines 34–35; human comment created
unchanged-region expansion: first visible line 34 -> 1
viewed checkbox: 1; Alt+ArrowDown: active file 1; collapse hides code

Both workers=0 and workers=1:
same CodeView item version: replacement ignored; inserted header not rendered
version bumped, naïve anchor: annotation-additions-34, target moved to 39
version bumped, host reanchor: annotation-additions-39, finding-0 identity retained
```

`CodeView` reconciles an existing item only when its `version` changes. Give each logical file a stable item ID, increment its version for new content/annotations/collapse state, and use immutable content-derived cache keys. A changed React object alone is not an update signal. The spike uses a SHA-256 patch key, distinct old/new revision keys, and an explicit version increment; it does not reproduce the older “replacement not rendered” report when that contract is followed.

API reference: [Pierre's official documentation](https://diffs.com/docs). Conclusions here use the installed 1.4.2 declarations/source and the recorded local experiments; later documentation may describe a different release.

Pierre annotations contain `side`, `lineNumber`, and application metadata. Metadata stores a stable finding ID; card state is held above the slotted/virtualized node. After a new commit, Pierre happily retains the old line number even though it now refers to different text. It neither resolves nor marks the finding outdated. The prototype demonstrates single-line relocation only; it is not a durable coordinator or a complete range/rename mapper.

The final readback also verifies actual code text: the original target renders at line 39, but the naïve card retains slot `annotation-additions-34`; line 34 is no longer a visible code row because it lies in collapsed context. With host relocation, both the slot and the unchanged target text are at line 39. Do not rely on a visible card as proof that its anchor still matches visible code.

### Built in versus Loom-owned

| Capability | Pierre primitive | Work Loom still owns |
|---|---|---|
| Split / unified | `diffStyle`; both visually and interactively checked | Preference/control. |
| Collapse unchanged regions | Hunk separators and expansion | Fetch full old/new blobs via `loadDiffFiles` for partial patches; expose unavailable context honestly. |
| Collapse a file | `CodeView` item `collapsed`, with version update | Control and any retained preference. |
| File list / jump | `CodeView.scrollTo({type:'item'…})`, also line/range targets | Sidebar, search/order and next/previous commands. |
| Viewed state | No review-level persisted viewed state | Store against file identity and reviewed blob/head in coordinator; invalidate on changes. |
| Keyboard review navigation | No complete review workflow | The demo's Alt+Up/Down is host code; full keyboard-only accessibility still needs a pass. |
| Findings/comments/CI | React annotation slots; gutter range selection | Finding schema, threads, resolve policy, durable drafts and anchoring. |

The test shell intentionally keeps demo state in React. In Loom, these are projections of coordinator state, and closing a window must not lose findings, viewed state or drafts. This spike does not change the architectural ownership rules.

### Inputs and fallback comparison

`parsePatchFiles(patch, contentKey, true)` accepts the multi-file Git patches and public PR patch. `parseDiffFromFile(oldFile, newFile)` accepts full contents, including CRLF; exact old/new CRLF round trips pass. Added/deleted files, pure renames and missing-final-newline markers parse. A deliberately truncated hunk throws `parsePatchContent: hunk line count mismatch`. Arbitrary non-patch text returns an empty list even with strict parsing: Loom must distinguish a verified empty diff from invalid/unexpected input.

Two concrete gaps:

* Git's default quoted filename `space \\303\\274.txt` stays octal-escaped in Pierre's `name`. A real `git -c core.quotePath=false diff` produces `space ü.txt`, which Pierre handles. Prefer NUL-delimited Git metadata for authoritative paths; use the per-command quoting flag and a tested Git C-string decoder where upstream patches remain quoted. Tabs/newlines and rename edge cases still need broader coverage.
* A binary change parses as an ordinary changed file with zero hunks. The browser shows `binary.dat-0+0` with no binary-change notice. Preserve binary/status metadata from Git/GitHub and render a Loom-owned binary/unsupported-file summary. Zero text hunks must not imply no change.

Because the quoted-path input failed, the brief's fallback was examined briefly: `@git-diff-view/react` 0.1.7 and its core parser. Its React props require caller-supplied old/new filenames plus hunks; its parser does not provide a replacement multi-file path decoder. It does expose `isBinary: true` on the same binary fixture. Supplying `space ü.txt` to `DiffFile` preserves it, but that still requires authoritative path handling in Loom. This bounded parser/API comparison gives no reason to replace Pierre; no claim is made about fallback performance or full review feature parity.

### Theme and visual checks

Bundled Inter for the shell/cards and JetBrains Mono for code load successfully. The shadow-root code has computed font `"JetBrains Mono Variable", monospace` and line height `20px`, matching the virtualizer metric. The light unified view and dark split view have no document-level horizontal overflow. Reviewed screenshots: [dark split](evidence/review-dark.png), [light unified](evidence/review-light-unified.png).

Shell CSS variables style the React annotation slots; static application-owned `unsafeCSS` sets the code font inside Shadow DOM. Patch or user data is never interpolated into CSS. Theme switching works with the pool's preconfigured dark/light theme pair; arbitrary theme-set replacement would require synchronizing worker render options.

## Implications for Loom

Keep the architecture's Pierre choice, but replace the spike-04 assumption during product implementation with these adapter requirements:

1. Use `CodeView`, a bounded worker pool and immutable revision cache keys. Keep diff acquisition/computation out of the renderer's critical path; a worker pool offloads highlighting, not every kind of diff generation or parsing.
2. Publish stable file IDs and monotonic item versions in coordinator snapshots. Version changes must cover content and annotation updates. Persist findings, replies, resolve state, drafts and viewed state in the coordinator; React slots only display them.
3. Separate Git/GitHub file metadata from patch rendering. Preserve binary/rename/status facts and authoritative paths. Supply full blobs for context expansion. Reject unexpected empty/invalid inputs instead of showing an apparently clean review.
4. Add the review shell: file list, jump/search, viewed controls, keyboard navigation and unavailable/outdated finding presentation. Do not infer task transitions from renderer state.

### Proposed annotation anchor

Store an immutable original anchor and a separately versioned current location:

| Field | Purpose |
|---|---|
| Finding UUID; source and external comment/check ID | Stable identity through rerenders, relocation and duplicate events. |
| Repository/task/worktree identity; original base/head SHA | Identify the exact review snapshot and owner. |
| Original old/new path and old/new blob OID | Resolve sides and verified renames; do not use the displayed filename as the sole join. |
| Side; start/end line, optional columns | Coordinates in that exact blob, not a unified patch row number. |
| Selected text/hash; surrounding context text/hashes | Validate a mapping and disambiguate repeated lines. Define byte/line-ending normalization explicitly. |
| Current head/blob/path/range and mapping status | Keep `exact`, `moved`, `ambiguous`, `outdated` separate from finding `open/resolved`. |

On a new head, fetch immutable old/new blobs and map ranges through Git hunks and verified rename metadata. Confirm selected/context hashes. If that mapping is unavailable, a unique text/context match may propose a relocation; ambiguous, changed or deleted targets stay visible as outdated findings with the original snippet. Never silently choose the nearest duplicate or mark a finding resolved because its line disappeared. Reconciliation against the same head must leave the same mapping unchanged. A human review/approval still applies to a specific head and finding snapshot.

The six prototype tests cover unchanged text, insertion above, deletion, editing, duplicate blocks, contextual disambiguation and blank-line ambiguity. They do not prove general range mapping, file moves or reordered identical code. A content hash alone is insufficient because identical text can occur in multiple places.

## Open questions

* Electron packaging/CSP, app protocol worker URLs, Windows/Linux, different GPUs, reduced-memory devices and worker crashes were not tested.
* Long review sessions, fully visiting/highlighting every file and sustained cache churn need a memory soak; six seconds of scrolling plus a far-file jump is a bounded sample.
* Complete keyboard-only and screen-reader review accessibility, touch selection, multiline/cross-side comments, renamed/deleted-file anchors and edited duplicate blocks need focused product tests.
* The plain React “viewed”/draft examples are transient; coordinator persistence/restart behavior is outside this spike.

## How to rerun

Requires Node 22+, npm, Git, authenticated `gh` for public PR access, and installed Google Chrome. From the repository root:

```sh
mkdir -p "$TMPDIR/loom-spike-04"
git clone --depth 2 --branch v3.5.21 https://github.com/vuejs/core.git "$TMPDIR/loom-spike-04/vue-core"
gh pr diff 15477 --repo vuejs/core > "$TMPDIR/loom-spike-04/github-15477.patch"
gh pr view 15477 --repo vuejs/core --json number,baseRefOid,headRefOid,mergeCommit > "$TMPDIR/loom-spike-04/github-15477.json"
cd spikes/04-pierre-diffs
npm ci
npm run fixtures
node --experimental-strip-types scripts/inputs.ts
node --experimental-strip-types scripts/comparison.ts
npm test
npm run build
npm run preview
```

Leave the preview server running on `127.0.0.1:4404`; in a second terminal in this spike directory:

```sh
node --experimental-strip-types scripts/features.ts
node --experimental-strip-types scripts/bench.ts core
node --experimental-strip-types scripts/bench.ts annotations
node --experimental-strip-types scripts/bench.ts baselines
node --experimental-strip-types scripts/bench.ts inputs
node --experimental-strip-types scripts/collect.ts
```

All generated input data, raw measurements and screenshots go under `$TMPDIR/loom-spike-04/`; Vite serves that data and copies it into the ignored build directory. Browser runs create and close their own processes. Stop only this preview process when done. For an existing fixture clone, skip the clone command; the fixture generator restores only its own changes and reruns reproducibly. If the public PR output changes, its recorded patch hash will differ and the evidence must be regenerated.

The test page accepts `fixture=medium|large|single|lockfile|commits|github|edges`, `workers=0|1`, `annotations=0|50|200`, `view=split|unified`, `renderer=codeview|virtualizer|plain`, `input=patch|contents` and `theme=dark|light`. Full-content mode requires a fixture that includes contents.

Repository gates also ran: `pnpm test`, `pnpm lint`, `pnpm typecheck`. They pass, but the root test suite currently has no product tests and root typecheck has no product workspaces. The spike is intentionally excluded from the workspace/lint scope; its own `npm test` and `npm run build` exercise the anchor logic and strict TypeScript build. Vite reports the expected large bundled-language chunk warning. Final dependency audit reports zero vulnerabilities.
