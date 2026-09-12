import type {
  GitHubAdapter,
  PaneHost,
  PaneObservation,
  PaneRef,
  PullRequestObservation,
  RunId,
  Sha,
  WorktreePath,
} from "@loom/core";
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
      sessionName: req.workspaceId,
      windowId: `@${n}`,
      paneId: `%${n}`,
    };
    this.launches.push(structuredClone(req));
    this.runs.set(req.runId, ref);
    this.panes.set(this.key(ref), {
      ref,
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
      sessionName: req.workspaceId,
      windowId: `@${n}`,
      paneId: `%${n}`,
    };
    this.panes.set(this.key(ref), {
      ref,
      sessionId: `$${n}`,
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
    this.hints.emit({
      source: "pane_host",
      sessionId: null,
      worktreePath: null,
    });
  }
  private key(ref: PaneRef) {
    return `${ref.hostGeneration}/${ref.sessionName}/${ref.windowId}/${ref.paneId}`;
  }
  private live(ref: PaneRef) {
    const p = this.panes.get(this.key(ref));
    if (!p || p.dead) throw new Error("Pane is unavailable");
    return p;
  }
}

/** One fake repository/branch per instance; check IDs model native IDs, independent of names. */
export class FakeGitHub implements GitHubAdapter {
  readonly hints = new Hints();
  private revision = 0;
  private remoteHead: Sha | null = null;
  private checkId = 102790590318;
  private commentId = 0;
  private pr: PullRequestObservation | null;
  constructor(
    readonly clock: FakeClock,
    readonly repo: string,
    readonly branch: string,
    initial: PullRequestObservation | null = null,
  ) {
    this.pr = structuredClone(initial);
    this.remoteHead = initial?.headSha ?? null;
  }
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
    if (pr.state === "merged") return { state: "merged" };
    if (pr.state !== "open") throw new Error("PR is closed");
    if (req.auto) {
      if (!pr.autoMergeEnabled) {
        pr.autoMergeEnabled = true;
        this.changed();
      }
      return { state: "auto_merge_enabled" };
    }
    if (pr.ci.conclusion !== "success") throw new Error("CI is not green");
    this.merge();
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
  merge() {
    const pr = this.requirePr();
    if (pr.state === "merged") return;
    pr.state = "merged";
    pr.mergeCommitSha = pr.headSha;
    pr.mergedAt = this.clock.now();
    pr.autoMergeEnabled = false;
    this.changed();
  }
  close() {
    const pr = this.requirePr();
    pr.state = "closed";
    pr.autoMergeEnabled = false;
    this.changed();
  }
  private requirePr(number?: number) {
    if (!this.pr || (number !== undefined && this.pr.number !== number))
      throw new Error("Unknown fake PR");
    return this.pr;
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
