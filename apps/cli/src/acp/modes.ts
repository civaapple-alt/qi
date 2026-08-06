import type { SessionMode } from "@agentclientprotocol/sdk";

/**
 * Qi Session modes for ACP (not Kimi's default/plan/auto/yolo).
 * Capabilities remain orthogonal grants — modes only narrow tool advertising.
 */
export const QI_ACP_MODES = [
  {
    id: "ask",
    name: "Ask",
    description: "Read-oriented Q&A; no Workspace writes, shell, or Subagents.",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Read exploration and Formal Plan drafting; no implementation tools.",
  },
  {
    id: "agent",
    name: "Agent",
    description: "Implementation with capabilities granted at launch / project policy.",
  },
] as const satisfies readonly SessionMode[];

export type QiAcpModeId = "ask" | "plan" | "agent";

export const DEFAULT_QI_ACP_MODE: QiAcpModeId = "agent";

export function isQiAcpModeId(value: unknown): value is QiAcpModeId {
  return value === "ask" || value === "plan" || value === "agent";
}
