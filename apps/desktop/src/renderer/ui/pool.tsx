// Pierre's highlight worker pool. Loaded after the first paint: it pulls in the diff renderer
// and Shiki's grammars, which is most of the bundle and none of what the list needs.

import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { ReactNode } from "react";

// Four workers. Without them a large diff paints fast and then freezes the main thread for
// seconds while it highlights (spike 04).
const poolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 4,
  totalASTLRUCacheSize: 100,
};

const highlighterOptions = {
  langs: ["typescript"],
  theme: { dark: "github-dark", light: "github-light" },
};

export function DiffPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
