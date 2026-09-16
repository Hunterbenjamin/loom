import type { ReactNode } from "react";
import { shortModelName } from "./format.js";

/** Shared authorship row for work produced by an agent or a GitHub author. */
export function Byline({
  name,
  agent = false,
  model,
  title,
  children,
}: {
  name: string;
  agent?: boolean;
  model?: string;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="pr-byline">
      <span className="pr-avatar" aria-hidden="true">
        {agent ? (
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <rect x="2.5" y="5" width="11" height="8.5" rx="2.5" />
            <path d="M8 2v3M6 9v1M10 9v1" />
          </svg>
        ) : (
          name.slice(0, 2).toUpperCase()
        )}
      </span>
      <span title={title}>
        {name}
        {agent ? (
          <span className="faint" title={model?.trim() || "Model not recorded"}>
            {" · "}
            {model?.trim() ? shortModelName(model) : "Model not recorded"}
          </span>
        ) : null}
      </span>
      {children ? <span className="faint">·</span> : null}
      {children}
    </div>
  );
}
