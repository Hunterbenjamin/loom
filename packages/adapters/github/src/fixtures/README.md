# Recorded GitHub CLI fixtures

Captured 2026-09-12 with `gh` 2.90.0 using the existing authenticated CLI, exclusively
GET requests to public `vuejs/core` PR #15477. These are real stdout envelopes from
`gh api --include <endpoint>`, trimmed to status, Content-Type, ETag, Link (if present),
and the JSON fields consumed by the adapter. Tokens, emails, unnecessary user metadata,
and commit author objects are not retained. Nonempty comment/review bodies are replaced
with `[Public comment body removed from fixture]`; empty review bodies remain empty.
Native IDs, paths, timestamps, author logins/types, status values, and SHAs are preserved.

| File | Endpoint under `repos/vuejs/core/` |
| --- | --- |
| `pulls.http` | `pulls?state=all&head=vuejs:edison/perf/treeshaking&sort=created&direction=desc&per_page=100` |
| `pull.http` | `pulls/15477` |
| `checks.http` | `commits/05c50f86b5fb9a95f30a4116e3bf4ab4d4bafa64/check-runs?per_page=100&filter=latest` |
| `statuses.http` | `commits/05c50f86b5fb9a95f30a4116e3bf4ab4d4bafa64/status` |
| `reviews.http` | `pulls/15477/reviews?per_page=100` |
| `issue-comments.http` | `issues/15477/comments?per_page=100` |
| `review-comments.http` | `pulls/15477/comments?per_page=100` |
| `not-modified.json` | `pulls/15477`, adding `--header 'If-None-Match: <recorded pull ETag>'` |

The 304 fixture uses a JSON envelope to preserve its header/body separator without a trailing blank line in the fixture file. The seven 200 responses exited 0. The 304 response exited **1**. No real repository
writes were made to manufacture a failing check or merge refusal. Unit tests explicitly
derive failing/queued checks, mergeability values, review summaries, pagination, moved
heads, auto-merge, missing fields, and CLI/API error responses from these fixtures.
Those variations are test scenarios, not additional claims about recorded live output.
