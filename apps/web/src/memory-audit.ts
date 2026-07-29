import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IndexedMemoryClaim } from "@civaapple/qi-agent/memory";
import type { SessionView } from "@civaapple/qi-agent/kernel";
import type { SessionEvent } from "@civaapple/qi-protocol";
import { SqliteMemoryIndex } from "@civaapple/qi-node/storage";

export interface WebMemoryUsage {
  readonly runId: string;
  readonly stepId: string;
  readonly included: readonly string[];
  readonly omitted: readonly string[];
}

export interface WebMemoryAudit {
  readonly claims: readonly IndexedMemoryClaim[];
  readonly usage: readonly WebMemoryUsage[];
  readonly userIndexAvailable: boolean;
}

export function projectMemoryAudit(
  projectsRoot: string,
  projectId: string,
  events: readonly SessionEvent[],
): WebMemoryAudit {
  const claims: IndexedMemoryClaim[] = [];
  const projectPath = join(projectsRoot, projectId, "state", "memory.sqlite");
  const userPath = join(dirname(projectsRoot), "state", "memory.sqlite");
  if (existsSync(projectPath)) claims.push(...readClaims(projectPath));
  const userIndexAvailable = existsSync(userPath);
  if (userIndexAvailable) claims.push(...readClaims(userPath));
  return {
    claims: deduplicateClaims(claims),
    usage: memoryUsage(events),
    userIndexAvailable,
  };
}

export function singleDatabaseMemoryAudit(
  view: SessionView,
  events: readonly SessionEvent[],
): WebMemoryAudit {
  return {
    claims: Object.values(view.memories) as IndexedMemoryClaim[],
    usage: memoryUsage(events),
    userIndexAvailable: false,
  };
}

function readClaims(path: string): IndexedMemoryClaim[] {
  const index = new SqliteMemoryIndex(path, { readonly: true });
  try {
    return index.list({ limit: 500 });
  } finally {
    index.close();
  }
}

function deduplicateClaims(claims: readonly IndexedMemoryClaim[]): IndexedMemoryClaim[] {
  return [...new Map(claims.map((claim) => [claim.memoryId, claim])).values()]
    .sort((left, right) =>
      right.validFrom.localeCompare(left.validFrom) || left.memoryId.localeCompare(right.memoryId));
}

function memoryUsage(events: readonly SessionEvent[]): WebMemoryUsage[] {
  return events
    .filter((event) => event.type === "context.compiled")
    .map((event) => ({
      runId: event.data.runId,
      stepId: event.data.stepId,
      included: event.data.includedBlockIds
        .filter((blockId) => blockId.startsWith("memory:"))
        .map((blockId) => blockId.slice("memory:".length)),
      omitted: event.data.omittedBlockIds
        .filter((blockId) => blockId.startsWith("memory:"))
        .map((blockId) => blockId.slice("memory:".length)),
    }))
    .filter((usage) => usage.included.length > 0 || usage.omitted.length > 0);
}
