import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { EventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { createId, type RunId, type SessionId } from "@civaapple/qi-protocol";

export type WatcherState = "active" | "stopped" | "completed" | "expired";

export interface WatcherDefinition {
  watcherId?: string;
  sessionId: SessionId;
  mode: "timer" | "event";
  intervalMs?: number;
  eventKey?: string;
  input?: string;
  createdAt: string;
  expiresAt: string;
  conditionId?: string;
}

export interface WatcherRecord extends Required<Pick<WatcherDefinition, "sessionId" | "mode" | "createdAt" | "expiresAt">> {
  watcherId: string;
  state: WatcherState;
  intervalMs?: number;
  eventKey?: string;
  input?: string;
  conditionId?: string;
  nextAt?: string;
  lastTriggeredAt?: string;
}

export interface TriggerSink {
  /** Must be idempotent for the supplied runId and honor signal before committing the Run. */
  trigger(input: { sessionId: SessionId; runId: RunId; source: "timer" | "event"; input?: string; signal: AbortSignal }): Promise<RunId>;
}

export interface AttentionGate {
  allows(now: Date): boolean;
}

export type ExternalCondition = (watcher: WatcherRecord, now: Date, payload?: unknown) => Promise<boolean>;

interface WatcherRow {
  watcher_id: string; session_id: string; mode: "timer" | "event"; interval_ms: number | null;
  event_key: string | null; input: string | null; created_at: string; expires_at: string;
  condition_id: string | null; next_at: string | null; last_triggered_at: string | null; state: WatcherState;
}

interface OccurrenceRow { occurrence_id: string; watcher_id: string; source: "timer" | "event"; input: string | null; status: "pending" | "delivered" | "cancelled"; run_id: string; }

export class SqliteWatcherScheduler {
  readonly #database: DatabaseSync;
  readonly #sink: TriggerSink;
  readonly #maximumLifetimeMs: number;
  readonly #attention: AttentionGate | undefined;
  readonly #conditions = new Map<string, ExternalCondition>();
  readonly #inFlight = new Map<string, AbortController>();
  #closed = false;

  constructor(path: string, sink: TriggerSink, options?: { maximumLifetimeMs?: number; attention?: AttentionGate }) {
    this.#database = new DatabaseSync(path);
    this.#sink = sink;
    this.#maximumLifetimeMs = options?.maximumLifetimeMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.#attention = options?.attention;
    if (!Number.isFinite(this.#maximumLifetimeMs) || this.#maximumLifetimeMs <= 0) throw new RangeError("maximumLifetimeMs must be positive");
    this.#database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS watchers (
        watcher_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('timer','event')),
        interval_ms INTEGER, event_key TEXT, input TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        condition_id TEXT, next_at TEXT, last_triggered_at TEXT,
        state TEXT NOT NULL CHECK(state IN ('active','stopped','completed','expired'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watcher_occurrences (
        occurrence_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL REFERENCES watchers(watcher_id),
        source TEXT NOT NULL CHECK(source IN ('timer','event')), input TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','delivered','cancelled')), run_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS watchers_due ON watchers(state,mode,next_at);
    `);
  }

  registerCondition(id: string, condition: ExternalCondition): () => void {
    if (!id || this.#conditions.has(id)) throw new Error(`Condition ${id || "<empty>"} is invalid or already registered`);
    this.#conditions.set(id, condition);
    return () => { if (this.#conditions.get(id) === condition) this.#conditions.delete(id); };
  }

  create(definition: WatcherDefinition): WatcherRecord {
    this.#assertOpen();
    validateDefinition(definition, this.#maximumLifetimeMs);
    const watcherId = definition.watcherId ?? `wat_${randomUUID()}`;
    const nextAt = definition.mode === "timer" ? definition.createdAt : undefined;
    this.#database.prepare(`INSERT INTO watchers
      (watcher_id,session_id,mode,interval_ms,event_key,input,created_at,expires_at,condition_id,next_at,state)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`).run(
        watcherId, definition.sessionId, definition.mode, definition.intervalMs ?? null,
        definition.eventKey ?? null, definition.input ?? null, definition.createdAt, definition.expiresAt,
        definition.conditionId ?? null, nextAt ?? null,
      );
    return this.get(watcherId)!;
  }

  get(watcherId: string): WatcherRecord | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM watchers WHERE watcher_id=?").get(watcherId) as WatcherRow | undefined;
    return row ? record(row) : undefined;
  }

  stop(watcherId: string): boolean {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const changed = Number(this.#database.prepare("UPDATE watchers SET state='stopped' WHERE watcher_id=? AND state='active'").run(watcherId).changes) > 0;
      if (changed) this.#database.prepare("UPDATE watcher_occurrences SET status='cancelled' WHERE watcher_id=? AND status='pending'").run(watcherId);
      this.#database.exec("COMMIT");
      if (changed) this.#inFlight.get(watcherId)?.abort(new Error(`Watcher ${watcherId} stopped`));
      return changed;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  async tick(now = new Date()): Promise<number> {
    this.#assertOpen();
    const rows = this.#database.prepare("SELECT * FROM watchers WHERE state='active' AND mode='timer' AND next_at<=? ORDER BY next_at,watcher_id").all(now.toISOString()) as unknown as WatcherRow[];
    let delivered = 0;
    for (const row of rows) {
      const watcher = record(row);
      if (await this.#settleIfClosed(watcher, now)) continue;
      if (this.#attention && !this.#attention.allows(now)) continue;
      const occurrenceId = `${watcher.watcherId}:timer:${row.next_at}`;
      if (this.#reserve(occurrenceId, watcher, "timer", watcher.input, now)) delivered += await this.#deliver(occurrenceId, watcher.watcherId, now);
    }
    return delivered;
  }

  async notify(eventKey: string, eventId: string, payload: unknown, now = new Date()): Promise<number> {
    this.#assertOpen();
    if (!eventKey || !eventId) throw new TypeError("Event key and stable event ID are required");
    const rows = this.#database.prepare("SELECT * FROM watchers WHERE state='active' AND mode='event' AND event_key=? ORDER BY watcher_id").all(eventKey) as unknown as WatcherRow[];
    let delivered = 0;
    for (const row of rows) {
      const watcher = record(row);
      if (await this.#settleIfClosed(watcher, now, payload)) continue;
      if (this.#attention && !this.#attention.allows(now)) continue;
      const occurrenceId = `${watcher.watcherId}:event:${eventId}`;
      const input = JSON.stringify({ configuredInput: watcher.input, eventKey, eventId, payload });
      if (Buffer.byteLength(input) > 100_000) throw new RangeError("Watcher event payload exceeds the Session trigger limit");
      if (this.#reserve(occurrenceId, watcher, "event", input, now)) delivered += await this.#deliver(occurrenceId, watcher.watcherId, now);
    }
    return delivered;
  }

  async recoverPending(now = new Date()): Promise<number> {
    this.#assertOpen();
    const rows = this.#database.prepare("SELECT o.* FROM watcher_occurrences o JOIN watchers w ON w.watcher_id=o.watcher_id WHERE o.status='pending' AND w.state='active' ORDER BY o.occurrence_id").all() as unknown as OccurrenceRow[];
    let delivered = 0;
    for (const row of rows) delivered += await this.#deliver(row.occurrence_id, row.watcher_id, now);
    return delivered;
  }

  close(): void {
    if (this.#closed) return;
    for (const controller of this.#inFlight.values()) controller.abort(new Error("Watcher scheduler closed"));
    this.#inFlight.clear();
    this.#database.close();
    this.#closed = true;
  }

  async #settleIfClosed(watcher: WatcherRecord, now: Date, payload?: unknown): Promise<boolean> {
    if (now.getTime() >= Date.parse(watcher.expiresAt)) { this.#closeWatcher(watcher.watcherId, "expired"); return true; }
    if (!watcher.conditionId) return false;
    const condition = this.#conditions.get(watcher.conditionId);
    if (!condition) throw new Error(`External condition ${watcher.conditionId} is not registered`);
    if (await condition(watcher, now, payload)) { this.#closeWatcher(watcher.watcherId, "completed"); return true; }
    return false;
  }

  #closeWatcher(watcherId: string, state: "completed" | "expired"): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("UPDATE watchers SET state=? WHERE watcher_id=? AND state='active'").run(state, watcherId);
      this.#database.prepare("UPDATE watcher_occurrences SET status='cancelled' WHERE watcher_id=? AND status='pending'").run(watcherId);
      this.#database.exec("COMMIT");
      this.#inFlight.get(watcherId)?.abort(new Error(`Watcher ${watcherId} ${state}`));
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  #reserve(occurrenceId: string, watcher: WatcherRecord, source: "timer" | "event", input: string | undefined, now: Date): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(watcher.watcherId);
      if (!current || current.state !== "active") { this.#database.exec("COMMIT"); return false; }
      const result = this.#database.prepare("INSERT OR IGNORE INTO watcher_occurrences (occurrence_id,watcher_id,source,input,status,run_id) VALUES (?,?,?,?, 'pending',?)").run(occurrenceId, watcher.watcherId, source, input ?? null, createId("run"));
      if (source === "timer" && Number(result.changes) > 0) {
        const next = new Date(Math.max(now.getTime(), Date.parse(current.nextAt!)) + current.intervalMs!).toISOString();
        this.#database.prepare("UPDATE watchers SET next_at=? WHERE watcher_id=?").run(next, watcher.watcherId);
      }
      this.#database.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  async #deliver(occurrenceId: string, watcherId: string, now: Date): Promise<number> {
    const occurrence = this.#database.prepare("SELECT * FROM watcher_occurrences WHERE occurrence_id=?").get(occurrenceId) as OccurrenceRow | undefined;
    const watcher = this.get(watcherId);
    if (!occurrence || occurrence.status !== "pending" || !watcher || watcher.state !== "active") return 0;
    const controller = new AbortController();
    this.#inFlight.set(watcherId, controller);
    let runId: RunId;
    try {
      runId = await this.#sink.trigger({
        sessionId: watcher.sessionId,
        runId: occurrence.run_id as RunId,
        source: occurrence.source,
        ...(occurrence.input === null ? {} : { input: occurrence.input }),
        signal: controller.signal,
      });
    } finally {
      if (this.#inFlight.get(watcherId) === controller) this.#inFlight.delete(watcherId);
    }
    if (runId !== occurrence.run_id) throw new Error(`TriggerSink returned ${runId}, expected stable Run ${occurrence.run_id}`);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.get(watcherId)?.state;
      if (state !== "active") {
        this.#database.prepare("UPDATE watcher_occurrences SET status='cancelled' WHERE occurrence_id=? AND status='pending'").run(occurrenceId);
        this.#database.exec("COMMIT");
        return 0;
      }
      this.#database.prepare("UPDATE watcher_occurrences SET status='delivered',run_id=? WHERE occurrence_id=? AND status='pending'").run(runId, occurrenceId);
      this.#database.prepare("UPDATE watchers SET last_triggered_at=? WHERE watcher_id=?").run(now.toISOString(), watcherId);
      this.#database.exec("COMMIT");
      return 1;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("Watcher scheduler is closed"); }
}

export class SessionEventTriggerSink implements TriggerSink {
  readonly #store: EventStore;
  constructor(store: EventStore) { this.#store = store; }
  async trigger(input: { sessionId: SessionId; runId: RunId; source: "timer" | "event"; input?: string; signal: AbortSignal }): Promise<RunId> {
    input.signal.throwIfAborted();
    const existing = this.#store.load(input.sessionId)?.runs[input.runId];
    if (existing) return input.runId;
    input.signal.throwIfAborted();
    new EventWriter(this.#store, input.sessionId).append("run.triggered", {
      runId: input.runId,
      trigger: input.source,
      ...(input.input === undefined ? {} : { input: input.input }),
    }, { kind: "runtime", id: "watcher-scheduler" });
    return input.runId;
  }
}

function validateDefinition(definition: WatcherDefinition, maximumLifetimeMs: number): void {
  const created = Date.parse(definition.createdAt), expires = Date.parse(definition.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) throw new TypeError("Watcher timestamps are invalid");
  if (expires - created > maximumLifetimeMs) throw new RangeError("Watcher exceeds the hard maximum lifetime");
  if (definition.mode === "timer" && (!Number.isInteger(definition.intervalMs) || definition.intervalMs! < 1_000)) throw new TypeError("Timer watcher intervalMs must be at least 1000");
  if (definition.mode === "event" && !definition.eventKey) throw new TypeError("Event watcher requires eventKey");
}

function record(row: WatcherRow): WatcherRecord {
  return {
    watcherId: row.watcher_id,
    sessionId: row.session_id as SessionId,
    mode: row.mode,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state: row.state,
    ...(row.interval_ms === null ? {} : { intervalMs: row.interval_ms }),
    ...(row.event_key === null ? {} : { eventKey: row.event_key }),
    ...(row.input === null ? {} : { input: row.input }),
    ...(row.condition_id === null ? {} : { conditionId: row.condition_id }),
    ...(row.next_at === null ? {} : { nextAt: row.next_at }),
    ...(row.last_triggered_at === null ? {} : { lastTriggeredAt: row.last_triggered_at }),
  };
}
