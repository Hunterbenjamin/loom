// Allow the existing node-based measurement scripts to share the TypeScript test harness.
import { tsImport } from "tsx/esm/api";
export const { startDesktopHarness } = await tsImport(
  "./desktop-harness.ts",
  import.meta.url,
);
