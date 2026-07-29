import type { MemoryLayer, MemoryStatus } from "../kernel/index.js";
import type {
  MemoryActivation,
  MemoryId,
  MemoryScope,
  SessionEvent,
  SessionId,
} from "@civaapple/qi-protocol";

export type CompatibleMemoryScope = MemoryScope | string;

export function memoryScopeKey(scope: CompatibleMemoryScope): string {
  if (typeof scope === "string") return `legacy:${scope}`;
  if (scope.kind === "session") return `session:${scope.sessionId}`;
  if (scope.kind === "project") return `project:${scope.projectId}`;
  return `user:${scope.userId}`;
}

export function memoryRelevanceScore(
  claim: Pick<IndexedMemoryClaim, "statement" | "confidence">,
  query?: string,
): number {
  const tokens = tokenizeMemoryQuery(query ?? "");
  if (tokens.length === 0) return claim.confidence;
  const haystack = claim.statement.toLocaleLowerCase();
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? token.length : 0), 0)
    / tokens.reduce((total, token) => total + token.length, 0);
}

function tokenizeMemoryQuery(query: string): string[] {
  const normalized = query.toLocaleLowerCase();
  const latin = normalized.split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length > 0 && !containsCjk(token));
  const cjkRuns = normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  ) ?? [];
  const cjk = cjkRuns.flatMap((run) => {
    const characters = [...run];
    return [
      ...characters,
      ...characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`),
    ];
  });
  return [...new Set([...latin, ...cjk])];
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

export interface IndexedMemoryClaim {
  memoryId: MemoryId;
  originSessionId: SessionId;
  operationId?: string;
  layer: MemoryLayer;
  statement: string;
  scope: CompatibleMemoryScope;
  provenance: Array<{ projectId?: string; sessionId: SessionId; eventId: string; sequence: number }>;
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  validFrom: string;
  expiresAt?: string;
  contradictionOf?: MemoryId;
  derivedFromMemoryId?: MemoryId;
  requiresConfirmation: boolean;
  status: MemoryStatus;
  activation: MemoryActivation;
  confirmedBy?: string;
  acceptedAt?: string;
  statusReason?: string;
  correctionMemoryId?: MemoryId;
}

export interface MemorySearchOptions {
  scopes: readonly CompatibleMemoryScope[];
  query?: string;
  layers?: readonly MemoryLayer[];
  maximumSensitivity?: "public" | "private" | "secret";
  activation?: MemoryActivation;
  limit?: number;
  now?: Date;
}

export interface MemoryListOptions {
  scopes?: readonly CompatibleMemoryScope[];
  statuses?: readonly MemoryStatus[];
  limit?: number;
}

export interface MemoryIndex {
  apply(event: SessionEvent): boolean;
  applyBatch(events: readonly SessionEvent[]): number;
  rebuild(events: readonly SessionEvent[]): void;
  get(memoryId: MemoryId): IndexedMemoryClaim | undefined;
  findByOperation(operationId: string): IndexedMemoryClaim | undefined;
  list(options?: MemoryListOptions): IndexedMemoryClaim[];
  search(options: MemorySearchOptions): IndexedMemoryClaim[];
}
