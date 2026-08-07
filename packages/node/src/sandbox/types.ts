import type { HostProcessOptions, HostProcessResult } from "../workspace/process.js";

/** ADR-0041 graded process sandbox backends. */
export type SandboxBackendId =
  | "srt-macos"
  | "srt-linux"
  | "srt-windows"
  | "win-low-il"
  | "host";

export type SandboxStrength = "full" | "reduced" | "none";

export type SandboxStatus = "active" | "reduced" | "unavailable" | "disabled";

export type SandboxPolicy = "auto" | "srt" | "low-il" | "never";

export interface SandboxBackendInfo {
  readonly backend: SandboxBackendId;
  readonly strength: SandboxStrength;
  readonly status: SandboxStatus;
  readonly reason: string;
  /** Tool classes this Runtime will wrap when calling through ProcessSandbox. */
  readonly wraps: readonly string[];
}

export interface SandboxSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: HostProcessOptions;
  /** Absolute Workspace root for allowWrite mapping. */
  readonly workspaceRoot: string;
  /** Extra absolute read-only roots (mounts). */
  readonly readOnlyRoots?: readonly string[];
}

/** Long-lived child rewrite for MCP stdio (and similar) that need stdin/stdout pipes. */
export interface SandboxCommandWrap {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Required when wrapping via cmd.exe /c on Windows (.cmd shims). */
  readonly windowsVerbatimArguments?: boolean;
}

export interface SandboxWrapRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readOnlyRoots?: readonly string[];
}

/**
 * Port for OS-level child process isolation. `@civaapple/qi-agent` never depends on this;
 * apps/cli and tools compose it at the node boundary.
 */
export interface ProcessSandbox {
  readonly info: SandboxBackendInfo;
  run(request: SandboxSpawnRequest): Promise<HostProcessResult>;
  /**
   * Rewrite a long-lived spawn (MCP stdio). Identity when the backend cannot wrap pipes
   * (honest host/low-il without token launch).
   */
  wrapCommand(request: SandboxWrapRequest): SandboxCommandWrap | Promise<SandboxCommandWrap>;
  /**
   * Optional warm-up (Windows srt ACL grants, etc.) so the first shell/verify is not a cold spike.
   * Host / low-il backends may omit this.
   */
  prewarm?(options: {
    readonly commands: readonly string[];
    readonly workspaceRoot: string;
    readonly readOnlyRoots?: readonly string[];
  }): Promise<void>;
}

export const DEFAULT_SANDBOX_WRAPS = [
  "shell",
  "script",
  "verify",
  "skill-script",
  "mcp-stdio",
] as const;
