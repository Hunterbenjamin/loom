import type {
  GitHubAdapter,
  PaneHost,
  PaneObservation,
  PaneRef,
  PullRequestDetail,
  PullRequestObservation,
  RunId,
  Sha,
  WorktreePath,
} from "@loom/core";
import { z } from "zod";
import type { FakeClock } from "./clock.js";
import { Hints } from "./providers.js";

export class FakePaneHost implements PaneHost {
  readonly hints = new Hints();
  readonly writes: { ref: PaneRef; text: string; timestamp: number }[] = [];
  readonly keys: {
    ref: PaneRef;
    key:
      | "Escape"
      | "Enter"
      | "0"
      | "1"
      | "2"
      | "3"
      | "4"
      | "5"
      | "6"
      | "7"
      | "8"
      | "9";
    timestamp: number;
  }[] = [];
  readonly launches: Parameters<PaneHost["ensurePane"]>[0][] = [];
  private panes = new Map<string, PaneObservation>();
  private runs = new Map<RunId, PaneRef>();
  private workspaces = new Map<string, WorktreePath>();
  private scratch = new Map<string, PaneRef>();
  private workspaceNames = new Map<string, string>();
  private generation = 1;
  private nextPane = 0;
  private now = 0;
  ensureWorkspace: PaneHost["ensureWorkspace"] = async (req) => {
    const workspaceId = `loom-${req.taskId}`;
    const existing = this.workspaces.get(workspaceId);
    if (existing && existing !== req.cwd)
      throw new Error("Workspace path mismatch");
    this.workspaces.set(workspaceId, req.cwd);
    return { workspaceId };
  };
  ensurePane: PaneHost["ensurePane"] = async (req) => {
    const existing = this.runs.get(req.runId);
    if (existing && !this.panes.get(this.key(existing))?.dead)
      return structuredClone(existing);
    if (this.workspaces.get(req.workspaceId) !== req.cwd)
      throw new Error("Unknown workspace or path mismatch");
    const n = this.nextPane++;
    const ref: PaneRef = {
      hostGeneration: `fake-${this.generation}`,
      sessionName: this.workspaceNames.get(req.workspaceId) ?? req.workspaceId,
      windowId: `@${n}`,
      paneId: `%${n}`,
    };
    this.launches.push(structuredClone(req));
    this.runs.set(req.runId, ref);
    this.panes.set(this.key(ref), {
      ref,
      sessionId: this.sessionId(ref.sessionName, n),
      workspaceId: req.workspaceId,
      cwd: req.cwd,
      startCwd: req.cwd,
      pid: 90000 + n,
      command: req.executable,
      dead: false,
      exitCode: null,
    });
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: req.cwd,
    });
    return structuredClone(ref);
  };
  createScratch: PaneHost["createScratch"] = async (req) => {
    if (req.createWorkspace && !this.workspaces.has(req.workspaceId))
      this.workspaces.set(req.workspaceId, req.cwd);
    if (this.workspaces.get(req.workspaceId) !== req.cwd)
      throw new Error("Unknown workspace");
    const title = req.label ?? `scratch-${req.key}`;
    const key = `${req.workspaceId}:${req.key}`;
    const refBefore = this.scratch.get(key);
    const existing = refBefore
      ? this.panes.get(this.key(refBefore))
      : undefined;
    if (existing && !existing.dead) return structuredClone(existing.ref);
    const n = this.nextPane++;
    const ref: PaneRef = {
      hostGeneration: `fake-${this.generation}`,
      sessionName: this.workspaceNames.get(req.workspaceId) ?? req.workspaceId,
      windowId: `@${n}`,
      paneId: `%${n}`,
    };
    this.panes.set(this.key(ref), {
      ref,
      sessionId: this.sessionId(ref.sessionName, n),
      workspaceId: req.workspaceId,
      windowName: title,
      title,
      cwd: req.cwd,
      startCwd: req.cwd,
      pid: 90000 + n,
      command: req.executable,
      dead: false,
      exitCode: null,
    });
    this.scratch.set(key, ref);
    return structuredClone(ref);
  };
  private sessionId(name: string, fallback: number) {
    return (
      [...this.panes.values()].find((pane) => pane.ref.sessionName === name)
        ?.sessionId ?? `$${fallback}`
    );
  }
  renameSession: PaneHost["renameSession"] = async (req) => {
    if (!req.name.trim() || /[.:\p{Cc}]/u.test(req.name))
      throw new Error(
        "Space names cannot contain . or : or control characters",
      );
    const panes = [...this.panes.values()];
    const matches = panes.filter(
      (pane) =>
        pane.ref.hostGeneration === req.hostGeneration &&
        pane.sessionId === req.sessionId,
    );
    if (!matches.length) throw new Error("Session is missing or stale");
    if (
      panes.some(
        (pane) =>
          pane.ref.sessionName === req.name && pane.sessionId !== req.sessionId,
      )
    )
      throw new Error("Duplicate session name");
    for (const pane of matches) {
      pane.workspaceId ??= pane.ref.sessionName;
      this.workspaceNames.set(pane.workspaceId, req.name);
      pane.ref.sessionName = req.name;
    }
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: null,
    });
  };
  renameWindow: PaneHost["renameWindow"] = async (req) => {
    if (!req.name.trim() || /[\p{Cc}]/u.test(req.name))
      throw new Error("Invalid tab name");
    const matches = [...this.panes.values()].filter(
      (pane) =>
        pane.ref.hostGeneration === req.hostGeneration &&
        pane.ref.windowId === req.windowId,
    );
    if (!matches.length) throw new Error("Window is missing or stale");
    for (const pane of matches) pane.windowName = req.name;
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: null,
    });
  };
  getPane: PaneHost["getPane"] = async (ref) =>
    structuredClone(this.panes.get(this.key(ref)) ?? null);
  listPanes: PaneHost["listPanes"] = async () =>
    structuredClone([...this.panes.values()]);
  pasteText: PaneHost["pasteText"] = async (ref, text) => {
    this.live(ref);
    this.writes.push({
      ref: structuredClone(ref),
      text,
      timestamp: this.now++,
    });
    return "written";
  };
  sendKey: PaneHost["sendKey"] = async (ref, key) => {
    this.live(ref);
    this.keys.push({ ref: structuredClone(ref), key, timestamp: this.now++ });
  };
  attachArgs: PaneHost["attachArgs"] = (ref) => {
    this.live(ref);
    return [
      "fake-tmux",
      "-L",
      "loom-fake",
      "attach-session",
      "-t",
      `${ref.sessionName}:${ref.windowId}.${ref.paneId}`,
    ];
  };
  listClients: PaneHost["listClients"] = async (ref) => {
    this.live(ref);
    return [];
  };
  closePane: PaneHost["closePane"] = async (ref) => {
    const p = this.panes.get(this.key(ref));
    if (!p || p.dead) return;
    this.exit(ref, 0);
  };
  closeTerminal: PaneHost["closeTerminal"] = async (ref) => {
    const pane = this.panes.get(this.key(ref));
    if (
      !pane ||
      pane.ref.sessionName !== ref.sessionName ||
      pane.ref.windowId !== ref.windowId
    )
      return;
    this.panes.delete(this.key(ref));
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: pane.startCwd,
    });
  };
  subscribe = this.hints.subscribe;
  exit(ref: PaneRef, exitCode: number) {
    const p = this.live(ref);
    p.dead = true;
    p.exitCode = exitCode;
    p.cwd = null;
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: p.startCwd,
    });
  }
  restart() {
    this.generation++;
    this.panes.clear();
    this.runs.clear();
    this.workspaces.clear();
    this.workspaceNames.clear();
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: null,
    });
  }
  private key(ref: PaneRef) {
    return `${ref.hostGeneration}/${ref.windowId}/${ref.paneId}`;
  }
  private live(ref: PaneRef) {
    const p = this.panes.get(this.key(ref));
    if (!p || p.dead) throw new Error("Pane is unavailable");
    return p;
  }
}

/** A repository with a primary workflow PR and independently seeded off-pipeline PRs. */
export class FakeGitHub implements GitHubAdapter {
  readonly hints = new Hints();
  private revision = 0;
  private remoteHead: Sha | null = null;
  private checkId = 102790590318;
  private commentId = 0;
  private pr: PullRequestObservation | null;
  private readonly additional = new Map<number, PullRequestObservation>();
  private readonly details = new Map<number, PullRequestDetail>();
  private readonly patches = new Map<number, string>();
  private readonly branches = new Set<string>();
  private readonly createdAt;
  private title = "Fake pull request";
  private body = "";

  constructor(
    readonly clock: FakeClock,
    readonly repo: string,
    readonly branch: string,
    initial: PullRequestObservation | null = null,
  ) {
    this.createdAt = clock.now();
    this.branches.add(branch);
    this.pr = structuredClone(initial);
    this.remoteHead = initial?.headSha ?? null;
  }
  /** Seed any PR, including ones with no Loom task. No provider process is involved. */
  setPullRequest(detail: PullRequestDetail, patch = "") {
    const observation: PullRequestObservation = {
      number: detail.number,
      url: detail.url,
      state: detail.state,
      headSha: detail.headSha,
      baseBranch: detail.base,
      mergeable: detail.mergeable,
      autoMergeEnabled: false,
      mergedAt: detail.mergedAt,
      mergeCommitSha: detail.mergeCommitSha,
      ci: {
        headSha: detail.headSha,
        conclusion: detail.checks,
        checks: detail.checkRuns,
        observedAt: detail.observedAt,
      },
      reviews:
        detail.review === "none"
          ? []
          : [
              {
                id: `review-${detail.number}`,
                author: "reviewer",
                state: detail.review,
                submittedAt: this.clock.now(),
              },
            ],
      comments: [],
    };
    if (
      this.pr?.number === detail.number ||
      (!this.pr && detail.head === this.branch)
    ) {
      this.pr = observation;
      this.remoteHead = detail.headSha;
      this.additional.delete(detail.number);
    } else this.additional.set(detail.number, observation);
    this.details.set(detail.number, structuredClone(detail));
    this.patches.set(detail.number, patch);
    this.branches.add(detail.head);
    this.changed();
  }
  branchExists(branch = this.branch) {
    return this.branches.has(branch);
  }
  readPullRequest: GitHubAdapter["readPullRequest"] = async (repo, number) => {
    this.scope(repo);
    return this.pullRequestDetail(number);
  };
  private pullRequestDetail(number: number): PullRequestDetail {
    const pr = this.requirePr(number);
    const detail = this.details.get(number);
    const latest = new Map<string, string>();
    for (const review of pr.reviews)
      if (review.state !== "commented") latest.set(review.author, review.state);
    const decisions = [...latest.values()];
    return structuredClone({
      number,
      title: this.title,
      viewerDidAuthor: true,
      viewerReviewRequested: false,
      reviewRequired: false,
      completedAt: null,
      author: "human",
      head: this.branch,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      draft: false,
      body: this.body,
      commits: [],
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      baseSha: "0".repeat(40) as Sha,
      files: [],
      reviews: [],
      comments: [],
      ...detail,
      branchExists: this.branches.has(detail?.head ?? this.branch),
      state: pr.state,
      base: pr.baseBranch,
      headSha: pr.headSha,
      url: pr.url,
      mergeable: pr.mergeable,
      checks: pr.ci.conclusion,
      review: decisions.includes("changes_requested")
        ? "changes_requested"
        : decisions.includes("approved")
          ? "approved"
          : "none",
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha,
      observedAt: this.clock.now(),
      checkRuns: pr.ci.checks.map((check) => ({
        startedAt: null,
        completedAt: null,
        ...check,
      })),
    });
  }
  listPullRequests: GitHubAdapter["listPullRequests"] = async (repo, state) => {
    this.scope(repo);
    const prs = [...(this.pr ? [this.pr] : []), ...this.additional.values()];
    const values = [];
    for (const pr of prs) {
      if (pr.state !== state) continue;
      const {
        requestedReviewers: _requestedReviewers,
        files: _fileDetails,
        reviews: _reviews,
        comments: _comments,
        branchExists: _branchExists,
        body: _body,
        commits: _commits,
        checkRuns: _runs,
        additions: _add,
        deletions: _del,
        changedFiles: _files,
        mergedAt: _at,
        mergeCommitSha: _sha,
        ...summary
      } = this.pullRequestDetail(pr.number);
      values.push(summary);
    }
    return values.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number,
    );
  };
  /** The native GraphQL list response, used to exercise the real adapter without gh. */
  async graphql(input: string) {
    const { variables } = z
      .object({
        query: z.string().min(1),
        variables: z.object({
          owner: z.string(),
          name: z.string(),
          state: z.enum(["OPEN", "MERGED", "CLOSED"]),
          cursor: z
            .string()
            .regex(/^cursor-\d+$/)
            .nullable(),
        }),
      })
      .parse(JSON.parse(input));
    const state = { OPEN: "open", MERGED: "merged", CLOSED: "closed" } as const;
    const rows = await this.listPullRequests(
      `${variables.owner}/${variables.name}`,
      state[variables.state],
    );
    const start = variables.cursor ? Number(variables.cursor.slice(7)) : 0;
    const page = rows.slice(start, start + 100);
    return {
      data: {
        repository: {
          pullRequests: {
            nodes: page.map((row) => ({
              number: row.number,
              viewerDidAuthor: row.viewerDidAuthor,
              viewerLatestReviewRequest: row.viewerReviewRequested
                ? { id: "request" }
                : null,
              closedAt: row.completedAt,
              title: row.title,
              author: row.author ? { login: row.author } : null,
              headRefName: row.head,
              baseRefName: row.base,
              headRefOid: row.headSha,
              baseRefOid: row.baseSha,
              isDraft: row.draft,
              mergeable: row.mergeable.toUpperCase(),
              reviewDecision: row.reviewRequired
                ? "REVIEW_REQUIRED"
                : row.review === "none"
                  ? null
                  : row.review.toUpperCase(),
              updatedAt: row.updatedAt,
              createdAt: row.createdAt,
              url: row.url,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup:
                        row.checks === "none"
                          ? null
                          : { state: row.checks.toUpperCase() },
                    },
                  },
                ],
              },
            })),
            pageInfo: {
              hasNextPage: start + 100 < rows.length,
              endCursor: page.length ? `cursor-${start + page.length}` : null,
            },
          },
        },
      },
    };
  }
  readPullRequestPatch: GitHubAdapter["readPullRequestPatch"] = async (
    repo,
    number,
    range,
  ) => {
    this.scope(repo);
    const pr = this.pullRequestDetail(number);
    if (range.headSha !== pr.headSha || range.baseSha !== pr.baseSha)
      throw new Error("Fake diff range is unavailable");
    const bytes = Buffer.from(this.patches.get(number) ?? "");
    const limit = 8 * 1024 * 1024;
    let end = Math.min(limit, bytes.length);
    while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80)
      end--;
    return {
      headSha: range.headSha,
      baseSha: range.baseSha,
      patch: bytes.subarray(0, end).toString("utf8"),
      truncated: bytes.length > limit,
      observedAt: this.clock.now(),
    };
  };
  readPullRequestBehind: GitHubAdapter["readPullRequestBehind"] = async (
    repo,
  ) => {
    this.scope(repo);
    return 0;
  };
  commentPullRequest: GitHubAdapter["commentPullRequest"] = async (
    repo,
    number,
    body,
    requestId,
  ) => {
    this.scope(repo);
    const detail = this.pullRequestDetail(number);
    if (detail.comments.some((comment) => comment.id === requestId)) return;
    detail.comments.push({
      id: requestId,
      author: "human",
      body,
      createdAt: this.clock.now(),
      url: detail.url,
    });
    this.setPullRequest(detail);
  };
  closePullRequest: GitHubAdapter["closePullRequest"] = async (
    repo,
    number,
  ) => {
    this.scope(repo);
    if (this.requirePr(number).state === "open") this.close(number);
  };
  deleteBranch: GitHubAdapter["deleteBranch"] = async (repo, branch) => {
    this.scope(repo);
    if (this.branches.delete(branch)) this.changed();
  };
  snapshot() {
    return structuredClone(this.pr);
  }
  findPullRequest: GitHubAdapter["findPullRequest"] = async (req) => {
    this.scope(req.repo, req.branch);
    const etag = `fake-${this.revision}`;
    return req.etag === etag
      ? { notModified: true }
      : { notModified: false, value: this.snapshot(), etag };
  };
  /** Test setup and a simulated push are explicit owner mutations. */
  setHead(head: Sha) {
    if (this.remoteHead === head) return;
    this.remoteHead = head;
    this.branches.add(this.branch);
    if (this.pr) {
      this.pr.headSha = head;
      this.ci("pending", true);
    } else this.changed();
  }
  openPullRequest: GitHubAdapter["openPullRequest"] = async (req) => {
    this.scope(req.repo, req.branch);
    if (!this.remoteHead)
      throw new Error("Set the fake remote head before opening a PR");
    if (!this.pr) {
      this.title = req.title;
      this.body = req.body;
      this.pr = {
        number: 1,
        url: "https://example.test/pull/1",
        state: "open",
        headSha: this.remoteHead,
        baseBranch: req.baseBranch,
        mergeable: "mergeable",
        autoMergeEnabled: false,
        mergeCommitSha: null,
        mergedAt: null,
        ci: {
          headSha: this.remoteHead,
          conclusion: "pending",
          checks: [],
          observedAt: this.clock.now(),
        },
        reviews: [],
        comments: [],
      };
      this.ci("pending", true);
    }
    return { number: this.pr.number, url: this.pr.url };
  };
  mergePullRequest: GitHubAdapter["mergePullRequest"] = async (req) => {
    this.scope(req.repo);
    const pr = this.requirePr(req.number);
    if (pr.headSha !== req.matchHeadSha)
      throw new Error("Head precondition failed");
    const deleteHead = async () => {
      if (req.deleteBranch)
        await this.deleteBranch(
          req.repo,
          this.details.get(pr.number)?.head ?? this.branch,
        );
    };
    if (pr.state === "merged") {
      await deleteHead();
      return { state: "merged" };
    }
    if (pr.mergeable === "conflicting") throw new Error("PR cannot be merged");
    if (pr.state !== "open") throw new Error("PR is closed");
    if (req.auto) {
      if (!pr.autoMergeEnabled) {
        pr.autoMergeEnabled = true;
        this.changed();
      }
      return { state: "auto_merge_enabled" };
    }
    if (pr.ci.conclusion !== "success") throw new Error("CI is not green");
    this.merge(req.number);
    await deleteHead();
    return { state: "merged" };
  };
  disableAutoMerge: GitHubAdapter["disableAutoMerge"] = async (req) => {
    this.scope(req.repo);
    const pr = this.requirePr(req.number);
    if (pr.autoMergeEnabled) {
      pr.autoMergeEnabled = false;
      this.changed();
    }
  };
  ci(conclusion: "success" | "failure" | "pending", newRun = false) {
    const pr = this.requirePr();
    const id =
      newRun || !pr.ci.checks.length
        ? String(++this.checkId)
        : (pr.ci.checks[0]?.id ?? String(++this.checkId));
    pr.ci = {
      headSha: pr.headSha,
      conclusion,
      observedAt: this.clock.now(),
      checks: [
        {
          id,
          name: "test / unit-test",
          status: conclusion === "pending" ? "in_progress" : "completed",
          conclusion: conclusion === "pending" ? null : conclusion,
          url: `https://example.test/check/${id}`,
        },
      ],
    };
    this.changed();
  }
  comment(
    body: string,
    path?: string,
    line?: number,
    changesRequested = false,
  ) {
    const pr = this.requirePr();
    const id = String(++this.commentId);
    if (changesRequested)
      pr.reviews.push({
        id: `review-${id}`,
        state: "changes_requested",
        author: "human",
        submittedAt: this.clock.now(),
      });
    pr.comments.push({
      id,
      reviewId: changesRequested ? `review-${id}` : null,
      path: path ?? null,
      line: line ?? null,
      side: path ? "new" : null,
      commitSha: pr.headSha,
      body,
      author: "human",
      createdAt: this.clock.now(),
    });
    this.changed();
  }
  merge(number?: number) {
    const pr = this.requirePr(number);
    if (pr.state === "merged") return;
    pr.state = "merged";
    pr.mergeCommitSha = pr.headSha;
    pr.mergedAt = this.clock.now();
    pr.autoMergeEnabled = false;
    this.changed();
  }
  close(number?: number) {
    const pr = this.requirePr(number);
    if (pr.state !== "open") return;
    pr.state = "closed";
    pr.autoMergeEnabled = false;
    this.changed();
  }
  private requirePr(number?: number) {
    const pr =
      number === undefined || this.pr?.number === number
        ? this.pr
        : this.additional.get(number);
    if (!pr) throw new Error("Unknown fake PR");
    return pr;
  }
  private scope(repo: string, branch = this.branch) {
    if (repo !== this.repo || branch !== this.branch)
      throw new Error("Fake GitHub scope mismatch");
  }
  private changed() {
    this.revision++;
    this.hints.emit({ source: "github", sessionId: null, worktreePath: null });
  }
}
