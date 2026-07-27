import { DatabaseSync } from "node:sqlite";
import type { MemoryLayer, MemoryStatus } from "@civaapple/qi-kernel";
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

interface ClaimRow {
  memory_id: MemoryId;
  origin_session_id: SessionId;
  layer: MemoryLayer;
  statement: string;
  scope: string;
  provenance_json: string;
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  valid_from: string;
  expires_at: string | null;
  contradiction_of: MemoryId | null;
  requires_confirmation: number;
  status: MemoryStatus;
  confirmed_by: string | null;
  status_reason: string | null;
  correction_memory_id: MemoryId | null;
}

export class SqliteMemoryIndex {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_claims (
        memory_id TEXT PRIMARY KEY,
        origin_session_id TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('working','episodic','semantic','procedural','relational')),
        statement TEXT NOT NULL,
        scope TEXT NOT NULL,
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','private','secret')),
        valid_from TEXT NOT NULL,
        expires_at TEXT,
        contradiction_of TEXT,
        requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0,1)),
        status TEXT NOT NULL CHECK (status IN ('candidate','accepted','disputed','forgotten')),
        confirmed_by TEXT,
        status_reason TEXT,
        correction_memory_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_applied_events (
        event_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        session_id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_scope_status ON memory_claims(scope, status);
    `);
  }

  apply(event: SessionEvent): boolean {
    this.#assertOpen();
    if (!event.type.startsWith("memory.")) return false;
    if (this.#database.prepare("SELECT 1 FROM memory_applied_events WHERE event_id=?").get(event.eventId)) return false;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      switch (event.type) {
        case "memory.candidate.created": {
          const previous = event.data.contradictionOf ? this.get(event.data.contradictionOf) : undefined;
          if (previous && previous.scope !== event.data.scope) throw new Error("A correction cannot change memory scope");
          this.#database.prepare(`
            INSERT INTO memory_claims (
              memory_id,origin_session_id,layer,statement,scope,provenance_json,confidence,sensitivity,
              valid_from,expires_at,contradiction_of,requires_confirmation,status
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'candidate')
          `).run(
            event.data.memoryId,
            event.sessionId,
            event.data.layer,
            event.data.statement,
            event.data.scope,
            JSON.stringify(event.data.provenance),
            event.data.confidence,
            event.data.sensitivity,
            event.data.validFrom,
            event.data.expiresAt ?? null,
            event.data.contradictionOf ?? null,
            event.data.requiresConfirmation ? 1 : 0,
          );
          break;
        }
        case "memory.accepted": {
          const claim = this.#required(event.data.memoryId);
          if (claim.status !== "candidate") throw new Error(`Memory ${claim.memory_id} is ${claim.status}`);
          this.#database.prepare("UPDATE memory_claims SET status='accepted', confirmed_by=? WHERE memory_id=?")
            .run(event.data.confirmedBy, event.data.memoryId);
          break;
        }
        case "memory.disputed":
          this.#required(event.data.memoryId);
          this.#database.prepare("UPDATE memory_claims SET status='disputed', status_reason=?, correction_memory_id=? WHERE memory_id=?")
            .run(event.data.reason, event.data.correctionMemoryId ?? null, event.data.memoryId);
          break;
        case "memory.forgotten":
          this.#required(event.data.memoryId);
          this.#database.prepare("UPDATE memory_claims SET status='forgotten', status_reason=? WHERE memory_id=?")
            .run(event.data.reason, event.data.memoryId);
          break;
      }
      this.#database.prepare("INSERT INTO memory_applied_events (event_id,sequence,session_id) VALUES (?,?,?)")
        .run(event.eventId, event.sequence, event.sessionId);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  rebuild(events: readonly SessionEvent[]): void {
    // Caller supplies append order; preserving it is essential for cross-stream causal references.
    for (const event of events) this.apply(event);
  }

  get(memoryId: MemoryId): IndexedMemoryClaim | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM memory_claims WHERE memory_id=?").get(memoryId) as ClaimRow | undefined;
    return row ? toClaim(row) : undefined;
  }

  search(options: {
    scopes: readonly string[];
    query?: string;
    layers?: readonly MemoryLayer[];
    maximumSensitivity?: "public" | "private" | "secret";
    limit?: number;
    now?: Date;
  }): IndexedMemoryClaim[] {
    this.#assertOpen();
    if (options.scopes.length === 0) return [];
    const maximum = options.limit ?? 20;
    if (!Number.isInteger(maximum) || maximum <= 0 || maximum > 500) throw new RangeError("Memory limit must be 1..500");
    const placeholders = options.scopes.map(() => "?").join(",");
    const rows = this.#database.prepare(
      `SELECT * FROM memory_claims WHERE status='accepted' AND layer!='working' AND scope IN (${placeholders})`,
    ).all(...options.scopes) as unknown as ClaimRow[];
    const now = (options.now ?? new Date()).getTime();
    const allowedSensitivity = sensitivityRank(options.maximumSensitivity ?? "private");
    const tokens = tokenize(options.query ?? "");
    return rows
      .map(toClaim)
      .filter((claim) => !claim.expiresAt || Date.parse(claim.expiresAt) > now)
      .filter((claim) => !options.layers || options.layers.includes(claim.layer))
      .filter((claim) => sensitivityRank(claim.sensitivity) <= allowedSensitivity)
      .map((claim) => ({ claim, score: score(claim, tokens) }))
      .filter((item) => tokens.length === 0 || item.score > 0)
      .sort((left, right) => right.score - left.score || right.claim.confidence - left.claim.confidence || left.claim.memoryId.localeCompare(right.claim.memoryId))
      .slice(0, maximum)
      .map((item) => item.claim);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #required(memoryId: MemoryId): ClaimRow {
    const row = this.#database.prepare("SELECT * FROM memory_claims WHERE memory_id=?").get(memoryId) as ClaimRow | undefined;
    if (!row) throw new Error(`Memory ${memoryId} does not exist in the index`);
    return row;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Memory index is closed");
  }
}

function toClaim(row: ClaimRow): IndexedMemoryClaim {
  return {
    memoryId: row.memory_id,
    originSessionId: row.origin_session_id,
    layer: row.layer,
    statement: row.statement,
    scope: row.scope,
    provenance: JSON.parse(row.provenance_json) as IndexedMemoryClaim["provenance"],
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    validFrom: row.valid_from,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.contradiction_of === null ? {} : { contradictionOf: row.contradiction_of }),
    requiresConfirmation: row.requires_confirmation === 1,
    status: row.status,
    ...(row.confirmed_by === null ? {} : { confirmedBy: row.confirmed_by }),
    ...(row.status_reason === null ? {} : { statusReason: row.status_reason }),
    ...(row.correction_memory_id === null ? {} : { correctionMemoryId: row.correction_memory_id }),
  };
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
}

function score(claim: IndexedMemoryClaim, tokens: readonly string[]): number {
  if (tokens.length === 0) return claim.confidence;
  const haystack = `${claim.statement} ${claim.scope}`.toLocaleLowerCase();
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0) / tokens.length;
}

function sensitivityRank(value: "public" | "private" | "secret"): number {
  return value === "public" ? 0 : value === "private" ? 1 : 2;
}
