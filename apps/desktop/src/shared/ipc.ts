/** The contract between the renderer and the Electron main process. Terminals only. */

export interface PtySpawnRequest {
  id: string;
  cols: number;
  rows: number;
  /** Shown in the panel header so the human knows what they are typing into. */
  label: string;
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

export interface HostBridge {
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
