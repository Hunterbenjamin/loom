import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { type GhResult, type GhRunner, response } from "./gh.js";
import { createGitHubAdapter } from "./index.js";
import * as s from "./schemas.js";

export const fixture = (name: string): string => {
  if (name === "not-modified") {
    const recorded = JSON.parse(
      readFileSync(
        new URL("./fixtures/not-modified.json", import.meta.url),
        "utf8",
      ),
    ) as { stdout: string };
    return recorded.stdout;
  }
  return readFileSync(
    new URL(`./fixtures/${name}.http`, import.meta.url),
    "utf8",
  );
};
export const ok = (stdout = ""): GhResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});
export const body = (name: string): unknown =>
  JSON.parse(response(ok(fixture(name))).body);
export const original = s.pull.parse(body("pull"));
export const request = {
  repo: "vuejs/core",
  branch: original.head.ref,
  etag: null,
};
export const root = "repos/vuejs/core";
export const pr = `${root}/pulls/${original.number}`;
export const list = `${root}/pulls?state=all&head=${encodeURIComponent(original.head.label)}&sort=created&direction=desc&per_page=100`;
export const checksPath = `${root}/commits/${original.head.sha}/check-runs?per_page=100&filter=latest`;
export const statusesPath = `${root}/commits/${original.head.sha}/status`;
export const reviewsPath = `${pr}/reviews?per_page=100`;
export const issuePath = `${root}/issues/${original.number}/comments?per_page=100`;
export const commentsPath = `${pr}/comments?per_page=100`;
export const mergeRequest = {
  repo: request.repo,
  number: original.number,
  matchHeadSha: original.head.sha,
  auto: false,
};
export const openRequest = {
  repo: request.repo,
  branch: request.branch,
  baseBranch: "minor",
  title: "Title",
  body: "line one\nline two `literal` $(literal)",
};

export function http(value: unknown, headers: Record<string, string> = {}) {
  const content = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(content).digest("hex")}"`;
  return `HTTP/2.0 200 OK\nEtag: ${etag}\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("")}\n${content}`;
}

export function setup(excludedAuthors: string[] = []) {
  const routes = new Map<string, GhResult>([
    [list, ok(fixture("pulls"))],
    [pr, ok(fixture("pull"))],
    [checksPath, ok(fixture("checks"))],
    [statusesPath, ok(fixture("statuses"))],
    [reviewsPath, ok(fixture("reviews"))],
    [issuePath, ok(fixture("issue-comments"))],
    [commentsPath, ok(fixture("review-comments"))],
  ]);
  const set = (
    endpoint: string,
    value: unknown,
    headers?: Record<string, string>,
  ) => routes.set(endpoint, ok(http(value, headers)));
  let mutate: GhRunner = async () => {
    throw new Error("Unexpected mutation");
  };
  const run = vi.fn<GhRunner>(async (args, input) => {
    if (
      args[0] !== "api" ||
      (args.includes("--method") && !args.includes("GET"))
    )
      return mutate(args, input);
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    const result = routes.get(endpoint ?? "");
    if (!result) throw new Error(`Missing fixture: ${endpoint}`);
    if (result.exitCode !== 0) return result;
    const etag = response(result).headers.etag;
    if (etag && args.includes(`If-None-Match: ${etag}`)) {
      return {
        stdout: `HTTP/2.0 304 Not Modified\nEtag: ${etag}\n\n`,
        stderr: "gh: HTTP 304",
        exitCode: 1,
      };
    }
    return result;
  });
  const adapter = createGitHubAdapter({
    excludedAuthors,
    run,
    now: () => new Date("2026-09-12T00:00:00Z"),
  });
  return {
    adapter,
    run,
    routes,
    set,
    mutate: (handler: GhRunner) => {
      mutate = handler;
    },
    open: () =>
      set(pr, {
        ...original,
        merged: false,
        state: "open",
        merged_at: null,
        mergeable: true,
      }),
  };
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}
