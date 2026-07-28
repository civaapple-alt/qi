import type { MemoryLayer, MemoryStatus } from "../kernel/index.js";
import type { MemoryId, SessionEvent, SessionId } from "@civaapple/qi-protocol";

export interface IndexedMemoryClaim {
  memoryId: MemoryId;
  originSessionId: SessionId;
  layer: MemoryLayer;
  statement: string;
  scope: string;
  provenance: Array<{ sessionId: SessionId; eventId: string; sequence: number }>;
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  validFrom: string;
  expiresAt?: string;
  contradictionOf?: MemoryId;
  requiresConfirmation: boolean;
  status: MemoryStatus;
  confirmedBy?: string;
  statusReason?: string;
  correctionMemoryId?: MemoryId;
}

export interface MemorySearchOptions {
  scopes: readonly string[];
  query?: string;
  layers?: readonly MemoryLayer[];
  maximumSensitivity?: "public" | "private" | "secret";
  limit?: number;
  now?: Date;
}

export interface MemoryIndex {
  apply(event: SessionEvent): boolean;
  rebuild(events: readonly SessionEvent[]): void;
  get(memoryId: MemoryId): IndexedMemoryClaim | undefined;
  search(options: MemorySearchOptions): IndexedMemoryClaim[];
}
