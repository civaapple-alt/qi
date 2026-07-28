import { DatabaseSync } from "node:sqlite";
import type {
  BeginEffectResult,
  EffectJournal,
  EffectRecord,
  EffectStatus,
} from "@civaapple/qi-agent/effects";

export type {
  BeginEffectResult,
  EffectJournal,
  EffectRecord,
  EffectStatus,
} from "@civaapple/qi-agent/effects";
export { effectIdempotencyKey, effectIntentHash } from "@civaapple/qi-agent/effects";

interface EffectRow {
  idempotency_key: string;
  intent_hash: string;
  action_id: string;
  status: EffectStatus;
  attempts: number;
  output_json: string | null;
  detail: string | null;
  updated_at: string;
}

export class SqliteEffectJournal implements EffectJournal {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS effects (
        idempotency_key TEXT PRIMARY KEY,
        intent_hash TEXT NOT NULL,
        action_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','started','completed','failed','indeterminate')),
        attempts INTEGER NOT NULL CHECK (attempts > 0),
        output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
        detail TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  begin(input: { idempotencyKey: string; intentHash: string; actionId: string; occurredAt?: string }): BeginEffectResult {
    this.#assertOpen();
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#row(input.idempotencyKey);
      if (!existing) {
        this.#database.prepare(
          "INSERT INTO effects (idempotency_key,intent_hash,action_id,status,attempts,updated_at) VALUES (?,?,?,?,1,?)",
        ).run(input.idempotencyKey, input.intentHash, input.actionId, "reserved", occurredAt);
        const record = this.#record(this.#requiredRow(input.idempotencyKey));
        this.#database.exec("COMMIT");
        return { outcome: "acquired", record };
      }
      if (existing.intent_hash !== input.intentHash) {
        throw new Error(`Idempotency key ${input.idempotencyKey} was reused for a different intent`);
      }
      if (existing.status === "completed") {
        const record = this.#record(existing);
        this.#database.exec("COMMIT");
        return { outcome: "replay", record, output: record.output };
      }
      if (existing.status === "failed") {
        this.#database.prepare(
          "UPDATE effects SET action_id=?, status='reserved', attempts=attempts+1, output_json=NULL, detail=NULL, updated_at=? WHERE idempotency_key=?",
        ).run(input.actionId, occurredAt, input.idempotencyKey);
        const record = this.#record(this.#requiredRow(input.idempotencyKey));
        this.#database.exec("COMMIT");
        return { outcome: "acquired", record };
      }
      const record = this.#record(existing);
      this.#database.exec("COMMIT");
      return {
        outcome: "blocked",
        record,
        reason: existing.status === "indeterminate"
          ? "Prior effect is indeterminate and requires reconciliation"
          : `Prior effect is still ${existing.status}`,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markStarted(idempotencyKey: string, occurredAt = new Date().toISOString()): EffectRecord {
    return this.#transition(idempotencyKey, ["reserved"], "started", undefined, undefined, occurredAt);
  }

  complete(idempotencyKey: string, output: unknown, occurredAt = new Date().toISOString()): EffectRecord {
    return this.#transition(idempotencyKey, ["started"], "completed", output, undefined, occurredAt);
  }

  fail(idempotencyKey: string, detail: string, occurredAt = new Date().toISOString()): EffectRecord {
    return this.#transition(idempotencyKey, ["started"], "failed", undefined, detail, occurredAt);
  }

  indeterminate(idempotencyKey: string, detail: string, occurredAt = new Date().toISOString()): EffectRecord {
    return this.#transition(idempotencyKey, ["reserved", "started"], "indeterminate", undefined, detail, occurredAt);
  }

  reconcile(
    idempotencyKey: string,
    outcome: "completed" | "failed",
    detail: string,
    output?: unknown,
    occurredAt = new Date().toISOString(),
  ): EffectRecord {
    return this.#transition(idempotencyKey, ["indeterminate"], outcome, output, detail, occurredAt);
  }

  get(idempotencyKey: string): EffectRecord | undefined {
    this.#assertOpen();
    const row = this.#row(idempotencyKey);
    return row ? this.#record(row) : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #transition(
    key: string,
    allowed: readonly EffectStatus[],
    next: EffectStatus,
    output: unknown,
    detail: string | undefined,
    occurredAt: string,
  ): EffectRecord {
    this.#assertOpen();
    const row = this.#requiredRow(key);
    if (!allowed.includes(row.status)) throw new Error(`Effect ${key} is ${row.status}, expected ${allowed.join(" or ")}`);
    const outputJson = output === undefined ? null : JSON.stringify(output);
    if (output !== undefined && outputJson === undefined) throw new TypeError("Effect output must be JSON-serializable");
    this.#database.prepare(
      "UPDATE effects SET status=?, output_json=?, detail=?, updated_at=? WHERE idempotency_key=?",
    ).run(next, outputJson ?? null, detail ?? null, occurredAt, key);
    return this.#record(this.#requiredRow(key));
  }

  #row(key: string): EffectRow | undefined {
    return this.#database.prepare("SELECT * FROM effects WHERE idempotency_key=?").get(key) as EffectRow | undefined;
  }

  #requiredRow(key: string): EffectRow {
    const row = this.#row(key);
    if (!row) throw new Error(`Effect ${key} does not exist`);
    return row;
  }

  #record(row: EffectRow): EffectRecord {
    return {
      idempotencyKey: row.idempotency_key,
      intentHash: row.intent_hash,
      actionId: row.action_id,
      status: row.status,
      attempts: row.attempts,
      ...(row.output_json === null ? {} : { output: JSON.parse(row.output_json) as unknown }),
      ...(row.detail === null ? {} : { detail: row.detail }),
      updatedAt: row.updated_at,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Effect Journal is closed");
  }
}
