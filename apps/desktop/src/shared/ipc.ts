import { paneIdentity, repoId, runId } from "@loom/protocol";
import { z } from "zod";
import type { ConnectionConfig } from "./connection.js";
export const ptySpawnRequest = z.strictObject({
  id: z.string().min(1).max(200),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  label: z.string().max(200),
  runId: runId.nullable().optional(),
  lead: repoId.optional(),
  operator: z.boolean().optional(),
  shellKey: z.string().uuid().optional(),
  shellName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
  pane: paneIdentity.optional(),
});
/** The contract between the renderer and the Electron main process. */

export interface PtySpawnRequest {
  id: string;
  cols: number;
  rows: number;
  /** Shown in the panel header so the human knows what they are typing into. */
  label: string;
  lead?: string;
  operator?: boolean;
  shellKey?: string;
  shellName?: string;
  pane?: import("@loom/protocol").PaneIdentity;
  runId?: import("@loom/core").RunId | null;
}

export interface PtySpawnResult {
  pid: number;
  /** What the main process actually ran, after resolving `LOOM_ATTACH_AGENT`. */
  command: string;
}

export interface PtyExit {
  exitCode: number;
  signal: number;
}

export interface TerminalBridge {
  spawn(request: PtySpawnRequest): Promise<PtySpawnResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): Promise<boolean>;
  onData(id: string, fn: (data: string) => void): void;
  onExit(id: string, fn: (info: PtyExit) => void): void;
  off(id: string): void;
}

export const windowMode = z.enum(["tracker", "workbench"]);
export type WindowMode = z.output<typeof windowMode>;
export interface NativeSettings {
  version: 1;
  windowMode: WindowMode;
  terminalHistoryLimit: number;
  keybindings: import("./keybindings.js").KeybindingsConfig;
}

export interface HostBridge {
  chooseRepository(): Promise<{ root: string; github: string } | null>;
  keybindings(): Promise<import("./keybindings.js").KeybindingsState>;
  onKeybindingsChanged(
    listener: (state: import("./keybindings.js").KeybindingsState) => void,
  ): () => void;
  applyNativeSettings?(settings: NativeSettings): Promise<void>;
  notify?(request: { id: string; title: string; body: string }): void;
  mode(): Promise<WindowMode>;
  setMode(mode: WindowMode): Promise<void>;
  onModeChanged(listener: (mode: WindowMode) => void): () => void;
  openWindow(mode: WindowMode): Promise<void>;
  connection(): Promise<ConnectionConfig>;
  /** Called once, after the first list paint. The cold-start measurement reads it. */
  interactive(): void;
  /** Electron's process metrics, used by the performance harness for idle CPU. */
  metrics(): Promise<{ type: string; cpu: { percentCPUUsage: number } }[]>;
  platform: string;
}

declare global {
  interface Window {
    loomTerminal: TerminalBridge;
    loomHost: HostBridge;
  }
}
