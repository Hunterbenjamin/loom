import type { PullRequestDetailRow } from "@loom/protocol";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ActivityItem } from "./activity.js";

type Detail = PullRequestDetailRow["detail"];
export function PrMarkdown({ body }: { body: string }) {
  return (
    <div className="pr-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
export function ChangeCounts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="pr-counts nums">
      <span className="good">+{additions}</span>{" "}
      <span className="danger">−{deletions}</span>
    </span>
  );
}
export function groupPrFiles(files: Detail["files"]) {
  return ["Implementation", "Tests"].map((name) => {
    const members = files.filter(
      (file) =>
        /(?:^|\/)(?:test|tests|__tests__)\/|(?:^|\/)[^/]*\.test\.[^/]+$/.test(
          file.path,
        ) ===
        (name === "Tests"),
    );
    return {
      name,
      files: members,
      additions: members.reduce((sum, file) => sum + file.additions, 0),
      deletions: members.reduce((sum, file) => sum + file.deletions, 0),
    };
  });
}
export function prActivity(pr: Detail): ActivityItem[] {
  const events: ActivityItem[] = [
    {
      id: "opened",
      at: pr.createdAt,
      label: `Opened by ${pr.author ?? "Unknown author"}`,
      url: pr.url,
      body: "",
      kind: "opened",
    },
    ...pr.commits.map((c) => ({
      id: `commit:${c.sha}`,
      at: c.committedAt,
      label: `${c.author ?? "Unknown author"} committed ${c.sha.slice(0, 7)} · ${c.message.split("\n")[0]}`,
      url: c.url,
      body: "",
      kind: "commit" as const,
    })),
    ...pr.reviews
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: `review:${r.id}`,
        at: r.submittedAt,
        label: `${r.author ?? "Unknown reviewer"} · ${r.state.toLowerCase().replaceAll("_", " ")}`,
        url: r.url,
        body: r.body,
        kind: "review" as const,
      })),
    ...pr.comments.map((c) => ({
      id: `comment:${c.id}`,
      at: c.createdAt,
      label: `${c.author ?? "Unknown author"} commented`,
      url: c.url,
      body: c.body.replace(/\n*<!-- loom-comment:[a-f0-9-]+ -->$/, ""),
      kind: "comment" as const,
    })),
    ...(pr.mergedAt
      ? [
          {
            id: "merged",
            at: pr.mergedAt,
            label: `Merged into ${pr.base}`,
            url: pr.url,
            body: "",
            kind: "merged" as const,
          },
        ]
      : []),
  ];
  return events.sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999"));
}
