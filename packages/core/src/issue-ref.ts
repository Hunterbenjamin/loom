import type { Repo, Run, Task } from "./entities.js";

function cleanRepoKey(value: string): string | null {
  const key = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return /^[A-Z]/.test(key) ? key : null;
}

export function repoKey(repo: Pick<Repo, "github" | "root">): string {
  const githubName = repo.github.split("/").filter(Boolean).at(-1) ?? "";
  const rootName =
    repo.root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? "";
  return cleanRepoKey(githubName) ?? cleanRepoKey(rootName) ?? "ISSUE";
}

export function issueKey(
  repo: Pick<Repo, "github" | "root">,
  task: Pick<Task, "number">,
): string {
  return `${repoKey(repo)}-${task.number}`;
}

export function truncateName(title: string, max = 32): string {
  const value = title.trim();
  if (value.length <= max) return value;
  if (max <= 0) return "";
  if (max === 1) return "…";
  const available = max - 1;
  const prefix = value.slice(0, available + 1);
  const boundary = prefix.lastIndexOf(" ");
  const cut = (
    boundary > 0 ? prefix.slice(0, boundary) : value.slice(0, available)
  )
    .trim()
    .replace(/[\s.,;:!?()[\]{}\-–—]+$/u, "");
  return `${cut || value.slice(0, available)}…`;
}

export function displayName(task: Pick<Task, "name" | "title">): string {
  return task.name ?? truncateName(task.title);
}

export function suggestName(title: string): string {
  const withoutParenthetical = title.trim().replace(/\s*\([^()]*\)\s*$/u, "");
  return truncateName(withoutParenthetical || title);
}

export function runLabel(run: Pick<Run, "role" | "round">): string {
  const role = `${run.role[0]?.toUpperCase() ?? ""}${run.role.slice(1)}`;
  return run.round >= 2 ? `${role} · round ${run.round}` : role;
}

export type ParsedTaskRef =
  | { id: string }
  | { number: number }
  | { key: string; number: number };

export function parseTaskRef(input: string): ParsedTaskRef {
  const value = input.trim();
  if (/^\d+$/.test(value)) return { number: Number(value) };
  if (!/^t-[a-f0-9]{8}$/i.test(value)) {
    const keyed = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(value);
    const key = keyed?.[1];
    if (key) return { key: key.toUpperCase(), number: Number(keyed?.[2]) };
  }
  return { id: value };
}

export type TaskRefResolution =
  | { ok: true; task: Task }
  | {
      ok: false;
      code: "unknown" | "ambiguous" | "outside_repo";
      message: string;
    };

export function resolveTaskRef(
  input: string,
  options: { tasks: readonly Task[]; repos: readonly Repo[]; repoId?: string },
): TaskRefResolution {
  const value = input.trim();
  const exact = options.tasks.find((task) => task.id === value);
  if (exact) {
    if (options.repoId && exact.repoId !== options.repoId)
      return {
        ok: false,
        code: "outside_repo",
        message: `${value} is outside this repository`,
      };
    return { ok: true, task: exact };
  }

  const parsed = parseTaskRef(value);
  if ("id" in parsed)
    return { ok: false, code: "unknown", message: `Unknown issue: ${value}` };
  const repos = new Map(options.repos.map((repo) => [repo.id, repo]));
  const numbered = options.tasks.filter(
    (task) =>
      task.number === parsed.number &&
      (!options.repoId || task.repoId === options.repoId),
  );
  const candidates =
    "key" in parsed
      ? numbered.filter((task) => {
          const repo = repos.get(task.repoId);
          return repo && repoKey(repo) === parsed.key;
        })
      : numbered;
  const soleCandidate = candidates.length === 1 ? candidates[0] : undefined;
  if (soleCandidate) return { ok: true, task: soleCandidate };
  if (candidates.length > 1) {
    const keys = candidates
      .map((task) => {
        const repo = repos.get(task.repoId);
        return repo ? issueKey(repo, task) : `${task.repoId}-${task.number}`;
      })
      .sort();
    return {
      ok: false,
      code: "ambiguous",
      message: `Ambiguous issue ${value}; candidates: ${keys.join(", ")}`,
    };
  }
  if (options.repoId && "key" in parsed) {
    const elsewhere = options.tasks.some((task) => {
      const repo = repos.get(task.repoId);
      return (
        task.number === parsed.number && repo && repoKey(repo) === parsed.key
      );
    });
    if (elsewhere)
      return {
        ok: false,
        code: "outside_repo",
        message: `${value} is outside this repository`,
      };
  }
  return { ok: false, code: "unknown", message: `Unknown issue: ${value}` };
}
