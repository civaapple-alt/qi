import { DatabaseSync } from "node:sqlite";
import type { MemoryLayer, MemoryStatus } from "@civaapple/qi-agent/kernel";
import type {
  CompatibleMemoryScope,
  IndexedMemoryClaim,
  MemoryIndex,
  MemoryListOptions,
  MemorySearchOptions,
} from "@civaapple/qi-agent/memory";
import { memoryRelevanceScore, memoryScopeKey } from "@civaapple/qi-agent/memory";
import type {
  MemoryActivation,
  MemoryId,
  MemoryScope,
  SessionEvent,
  SessionId,
} from "@civaapple/qi-protocol";

interface ClaimRow {
  memory_id: MemoryId;
  origin_session_id: SessionId;
  operation_id: string | null;
  layer: MemoryLayer;
  statement: string;
  scope: string;
  scope_key: string;
  provenance_json: string;
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  valid_from: string;
  expires_at: string | null;
  contradiction_of: MemoryId | null;
  derived_from_memory_id: MemoryId | null;
  requires_confirmation: number;
  status: MemoryStatus;
  activation: MemoryActivation;
  confirmed_by: string | null;
  accepted_at: string | null;
  status_reason: string | null;
  correction_memory_id: MemoryId | null;
}

export class SqliteMemoryIndex implements MemoryIndex {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.#database = new DatabaseSync(path, { readOnly: options.readonly ?? false });
    if (!(options.readonly ?? false)) this.#initialize();
  }

  apply(event: SessionEvent): boolean {
    return this.applyBatch([event]) > 0;
  }

  applyBatch(events: readonly SessionEvent[]): number {
    this.#assertOpen();
    const memoryEvents = events.filter((event) => event.type.startsWith("memory."));
    if (memoryEvents.length === 0) return 0;
    this.#database.exec("BEGIN IMMEDIATE");
    let applied = 0;
    try {
      for (const event of memoryEvents) {
        if (this.#database.prepare("SELECT 1 FROM memory_applied_events WHERE event_id=?").get(event.eventId)) {
          continue;
        }
        this.#applyEvent(event);
        this.#database.prepare(
          "INSERT INTO memory_applied_events (event_id,sequence,session_id) VALUES (?,?,?)",
        ).run(event.eventId, event.sequence, event.sessionId);
        applied += 1;
      }
      this.#database.exec("COMMIT");
      return applied;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  rebuild(events: readonly SessionEvent[]): void {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec("DELETE FROM memory_claims; DELETE FROM memory_applied_events;");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.applyBatch(events);
  }

  get(memoryId: MemoryId): IndexedMemoryClaim | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM memory_claims WHERE memory_id=?").get(memoryId) as
      | ClaimRow
      | undefined;
    return row ? toClaim(row) : undefined;
  }

  findByOperation(operationId: string): IndexedMemoryClaim | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM memory_claims WHERE operation_id=?").get(operationId) as
      | ClaimRow
      | undefined;
    return row ? toClaim(row) : undefined;
  }

  list(options: MemoryListOptions = {}): IndexedMemoryClaim[] {
    this.#assertOpen();
    const maximum = validateLimit(options.limit ?? 100);
    const rows = this.#database.prepare("SELECT * FROM memory_claims").all() as unknown as ClaimRow[];
    const scopeKeys = options.scopes?.map(memoryScopeKey);
    return rows
      .map(toClaim)
      .filter((claim) => !scopeKeys || scopeKeys.includes(memoryScopeKey(claim.scope)))
      .filter((claim) => !options.statuses || options.statuses.includes(claim.status))
      .sort((left, right) => right.validFrom.localeCompare(left.validFrom) || left.memoryId.localeCompare(right.memoryId))
      .slice(0, maximum);
  }

  search(options: MemorySearchOptions): IndexedMemoryClaim[] {
    this.#assertOpen();
    if (options.scopes.length === 0) return [];
    const maximum = validateLimit(options.limit ?? 20);
    const keys = options.scopes.map(memoryScopeKey);
    const placeholders = keys.map(() => "?").join(",");
    const rows = this.#database.prepare(
      `SELECT * FROM memory_claims
       WHERE status='accepted' AND layer!='working' AND scope_key IN (${placeholders})`,
    ).all(...keys) as unknown as ClaimRow[];
    const now = (options.now ?? new Date()).getTime();
    const allowedSensitivity = sensitivityRank(options.maximumSensitivity ?? "private");
    const query = options.query ?? "";
    const ranked = rows
      .map(toClaim)
      .filter((claim) => Date.parse(claim.validFrom) <= now)
      .filter((claim) => !claim.expiresAt || Date.parse(claim.expiresAt) > now)
      .filter((claim) => !options.layers || options.layers.includes(claim.layer))
      .filter((claim) => options.activation === undefined || claim.activation === options.activation)
      .filter((claim) => sensitivityRank(claim.sensitivity) <= allowedSensitivity)
      .map((claim) => ({ claim, score: memoryRelevanceScore(claim, query) }))
      .filter((item) => !query.trim() || item.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || right.claim.confidence - left.claim.confidence
        || (right.claim.acceptedAt ?? right.claim.validFrom).localeCompare(left.claim.acceptedAt ?? left.claim.validFrom)
        || left.claim.memoryId.localeCompare(right.claim.memoryId));
    const seen = new Set<string>();
    return ranked
      .filter(({ claim }) => {
        const normalized = claim.statement.trim().replace(/\s+/g, " ").toLocaleLowerCase();
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .slice(0, maximum)
      .map((item) => item.claim);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #initialize(): void {
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS memory_claims (
        memory_id TEXT PRIMARY KEY,
        origin_session_id TEXT NOT NULL,
        operation_id TEXT,
        layer TEXT NOT NULL CHECK (layer IN ('working','episodic','semantic','procedural','relational')),
        statement TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','private','secret')),
        valid_from TEXT NOT NULL,
        expires_at TEXT,
        contradiction_of TEXT,
        derived_from_memory_id TEXT,
        requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0,1)),
        status TEXT NOT NULL CHECK (status IN ('candidate','accepted','disputed','forgotten')),
        activation TEXT NOT NULL DEFAULT 'relevant' CHECK (activation IN ('relevant','always')),
        confirmed_by TEXT,
        accepted_at TEXT,
        status_reason TEXT,
        correction_memory_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_applied_events (
        event_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        session_id TEXT NOT NULL
      ) STRICT;
    `);
    this.#migrateLegacyTable();
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS memory_scope_status ON memory_claims(scope_key, status);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_operation_unique
        ON memory_claims(operation_id) WHERE operation_id IS NOT NULL;
      PRAGMA user_version = 2;
    `);
  }

  #migrateLegacyTable(): void {
    const columns = new Set(
      (this.#database.prepare("PRAGMA table_info(memory_claims)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ["operation_id", "TEXT"],
      ["scope_key", "TEXT"],
      ["derived_from_memory_id", "TEXT"],
      ["activation", "TEXT NOT NULL DEFAULT 'relevant'"],
      ["accepted_at", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.#database.exec(`ALTER TABLE memory_claims ADD COLUMN ${name} ${definition}`);
    }
    const rows = this.#database.prepare(
      "SELECT memory_id, scope FROM memory_claims WHERE scope_key IS NULL OR scope_key=''",
    ).all() as Array<{ memory_id: string; scope: string }>;
    const update = this.#database.prepare("UPDATE memory_claims SET scope_key=? WHERE memory_id=?");
    for (const row of rows) update.run(memoryScopeKey(parseStoredScope(row.scope)), row.memory_id);
  }

  #applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case "memory.user.asserted":
        return;
      case "memory.candidate.created": {
        const previous = event.data.contradictionOf ? this.get(event.data.contradictionOf) : undefined;
        if (previous && memoryScopeKey(previous.scope) !== memoryScopeKey(event.data.scope)) {
          throw new Error("A correction cannot change memory scope");
        }
        this.#database.prepare(`
          INSERT INTO memory_claims (
            memory_id,origin_session_id,operation_id,layer,statement,scope,scope_key,provenance_json,
            confidence,sensitivity,valid_from,expires_at,contradiction_of,derived_from_memory_id,
            requires_confirmation,status,activation
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'candidate', 'relevant')
        `).run(
          event.data.memoryId,
          event.sessionId,
          event.data.operationId ?? null,
          event.data.layer,
          event.data.statement,
          serializeScope(event.data.scope),
          memoryScopeKey(event.data.scope),
          JSON.stringify(event.data.provenance),
          event.data.confidence,
          event.data.sensitivity,
          event.data.validFrom,
          event.data.expiresAt ?? null,
          event.data.contradictionOf ?? null,
          event.data.derivedFromMemoryId ?? null,
          event.data.requiresConfirmation ? 1 : 0,
        );
        return;
      }
      case "memory.accepted": {
        const claim = this.#required(event.data.memoryId);
        if (claim.status !== "candidate") throw new Error(`Memory ${claim.memory_id} is ${claim.status}`);
        this.#database.prepare(
          "UPDATE memory_claims SET status='accepted', confirmed_by=?, accepted_at=? WHERE memory_id=?",
        ).run(event.data.confirmedBy, event.occurredAt, event.data.memoryId);
        return;
      }
      case "memory.disputed":
        this.#required(event.data.memoryId);
        this.#database.prepare(
          "UPDATE memory_claims SET status='disputed', status_reason=?, correction_memory_id=? WHERE memory_id=?",
        ).run(event.data.reason, event.data.correctionMemoryId ?? null, event.data.memoryId);
        return;
      case "memory.forgotten":
        this.#required(event.data.memoryId);
        this.#database.prepare(
          "UPDATE memory_claims SET status='forgotten', status_reason=? WHERE memory_id=?",
        ).run(event.data.reason, event.data.memoryId);
        return;
      case "memory.activation.changed":
        this.#required(event.data.memoryId);
        this.#database.prepare("UPDATE memory_claims SET activation=? WHERE memory_id=?")
          .run(event.data.activation, event.data.memoryId);
        return;
      default:
        return;
    }
  }

  #required(memoryId: MemoryId): ClaimRow {
    const row = this.#database.prepare("SELECT * FROM memory_claims WHERE memory_id=?").get(memoryId) as
      | ClaimRow
      | undefined;
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
    ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
    layer: row.layer,
    statement: row.statement,
    scope: parseStoredScope(row.scope),
    provenance: JSON.parse(row.provenance_json) as IndexedMemoryClaim["provenance"],
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    validFrom: row.valid_from,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.contradiction_of === null ? {} : { contradictionOf: row.contradiction_of }),
    ...(row.derived_from_memory_id === null ? {} : { derivedFromMemoryId: row.derived_from_memory_id }),
    requiresConfirmation: row.requires_confirmation === 1,
    status: row.status,
    activation: row.activation,
    ...(row.confirmed_by === null ? {} : { confirmedBy: row.confirmed_by }),
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    ...(row.status_reason === null ? {} : { statusReason: row.status_reason }),
    ...(row.correction_memory_id === null ? {} : { correctionMemoryId: row.correction_memory_id }),
  };
}

function serializeScope(scope: CompatibleMemoryScope): string {
  return typeof scope === "string" ? scope : JSON.stringify(scope);
}

function parseStoredScope(value: string): CompatibleMemoryScope {
  if (value.startsWith("{")) {
    try {
      const decoded = JSON.parse(value) as MemoryScope;
      if (decoded.kind === "session" || decoded.kind === "project" || decoded.kind === "user") return decoded;
    } catch {
      // Preserve malformed historical values as legacy scope strings.
    }
  }
  return value;
}

function sensitivityRank(value: "public" | "private" | "secret"): number {
  return value === "public" ? 0 : value === "private" ? 1 : 2;
}

function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 500) throw new RangeError("Memory limit must be 1..500");
  return value;
}
