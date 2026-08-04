import type { SessionSummary } from "@civaapple/qi-agent/kernel";

/**
 * Coordinator creates depth-1 child Sessions with `Delegated: …` titles.
 * Web Recent Sessions omit those so the picker stays parent-task oriented;
 * child Sessions remain openable via Subagent Tasks → Open child.
 */
export function isDelegatedSubagentSessionTitle(title: string): boolean {
  return title.startsWith("Delegated:");
}

export function listPrimarySessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((item) => !isDelegatedSubagentSessionTitle(item.title));
}
