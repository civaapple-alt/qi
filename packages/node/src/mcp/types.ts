import type { Effect } from "@civaapple/qi-agent/capability";

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerDeclaration {
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  scope: "workspace" | "user";
  sourcePath: string;
  /**
   * Parent dir under the user/workspace MCP root when nested (plugin marketplace materialization).
   * Discovery sets `name` to `${short}@${marketplace}` so it does not shadow `.qi/mcp/<short>.toml`.
   */
  marketplace?: string;
  command?: string;
  args: readonly string[];
  cwd?: string;
  url?: string;
  env: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string>>;
  credentialAlias?: string;
  oauth?: {
    redirectUrl: string;
    scopes: readonly string[];
  };
  connectTimeoutMs: number;
  callTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface McpCandidateSnapshot {
  server: string;
  capturedAt: string;
  serverInfo?: Readonly<Record<string, unknown>>;
  instructions?: string;
  instructionsFingerprint?: string;
  transportIdentity?: Readonly<Record<string, unknown>>;
  tools: readonly McpCandidate[];
  resources: readonly McpCandidate[];
  resourceTemplates: readonly McpCandidate[];
  prompts: readonly McpCandidate[];
}

export interface McpCandidate {
  kind: "tool" | "resource" | "resource-template" | "prompt";
  name: string;
  description?: string;
  uri?: string;
  raw: Readonly<Record<string, unknown>>;
  fingerprint: string;
}

export interface McpBinding {
  server: string;
  kind: McpCandidate["kind"] | "instructions";
  name: string;
  fingerprint: string;
  effect: Effect;
  resourcePatterns: readonly string[];
  reviewedAt: string;
  state: "bound" | "drifted";
}

export interface McpReviewDocument {
  schemaVersion: 1;
  bindings: Record<string, McpBinding>;
  snapshots: Record<string, McpCandidateSnapshot>;
}

export type McpConnectionStatus = "disabled" | "quarantined" | "connecting" | "ready" | "needs-auth" | "drifted" | "failed" | "idle";

export interface McpServerStatus {
  name: string;
  transport: McpTransportKind;
  status: McpConnectionStatus;
  scope: "workspace" | "user";
  /** Present when the declaration was discovered under a marketplace subdirectory (`name` is then `short@marketplace`). */
  marketplace?: string;
  detail?: string;
  candidateCount: number;
  bindingCount: number;
}
