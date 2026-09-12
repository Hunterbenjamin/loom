import type { z } from "zod";
import { type GhRunner, GitHubError, json, parse, response } from "./gh.js";

interface CachedPage {
  etag: string | null;
  body: unknown;
  next: string | null;
}
export type Pages = Map<string, CachedPage>;

/** A per-poll cache. Only committed after every resource has been read successfully. */
export class Api {
  readonly pages: Pages = new Map();
  constructor(
    private readonly run: GhRunner,
    private readonly previous: Pages = new Map(),
  ) {}

  async get<T>(endpoint: string, schema: z.ZodType<T>, conditional = true) {
    const cached = this.pages.get(endpoint) ?? this.previous.get(endpoint);
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      "--header",
      "Accept: application/vnd.github+json",
      endpoint,
    ];
    if (conditional && cached?.etag)
      args.push("--header", `If-None-Match: ${cached.etag}`);
    const result = response(await this.run(args));
    let page: CachedPage;
    if (result.status === 304) {
      if (!cached)
        throw new GitHubError(
          "retryable",
          "GitHub returned 304 without a cached response",
        );
      page = { ...cached, etag: result.headers.etag ?? cached.etag };
    } else {
      const nextLink = result.headers.link
        ?.split(",")
        .find((link) => /;\s*rel="next"/.test(link));
      let next: string | null = null;
      if (nextLink) {
        const target = /<([^>]+)>/.exec(nextLink)?.[1];
        if (!target)
          throw new GitHubError("fatal", "Invalid GitHub pagination");
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          throw new GitHubError("fatal", "Invalid GitHub pagination");
        }
        // Follow only pagination of this resource, never arbitrary endpoints/hosts from output.
        if (
          url.origin !== "https://api.github.com" ||
          url.pathname !== `/${endpoint.split("?")[0]}` ||
          url.username ||
          url.password
        )
          throw new GitHubError("fatal", "Invalid GitHub pagination target");
        next = `${url.pathname.slice(1)}${url.search}`;
      }
      page = {
        etag: result.headers.etag ?? null,
        body: json(result.body),
        next,
      };
    }
    const value = parse(schema, page.body);
    this.pages.set(endpoint, page);
    return { value, next: page.next };
  }

  async all<T>(endpoint: string, schema: z.ZodType<T[]>) {
    const values: T[] = [];
    const visited = new Set<string>();
    let next: string | null = endpoint;
    while (next) {
      if (visited.has(next) || visited.size >= 1000)
        throw new GitHubError(
          "retryable",
          "GitHub pagination did not complete",
        );
      visited.add(next);
      const cached = this.previous.get(next);
      // A full last page can gain a next page without its body (and ETag) changing.
      // Refresh its Link header unconditionally so appends cannot be hidden by a 304.
      const conditional = !(
        cached &&
        !cached.next &&
        parse(schema, cached.body).length >= 100
      );
      const page: { value: T[]; next: string | null } = await this.get(
        next,
        schema,
        conditional,
      );
      values.push(...page.value);
      next = page.next;
    }
    return values;
  }
}
