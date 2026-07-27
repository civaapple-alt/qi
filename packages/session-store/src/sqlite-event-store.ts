import { DatabaseSync } from "node:sqlite";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import {
  ConcurrencyError,
  StateTransitionError,
  replaySession,
  type EventStore,
  type EventStream,
  type SessionSummary,
  type SessionView,
} from "@civaapple/qi-kernel";

interface VersionRow {
  version: number;
}

interface EventRow {
  event_json: string;
}

interface SessionSummaryRow {
  session_id: string;
  version: number;
  title: string | null;
  updated_at: string;
}

export interface SqliteEventStoreOptions {
  readonly?: boolean;
}

export class SqliteEventStore implements EventStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string, options: SqliteEventStoreOptions = {}) {
    this.#database = new DatabaseSync(path, {
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: true,
    });

    if (!options.readonly) {
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS session_streams (
          session_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS session_events (
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          event_json TEXT NOT NULL CHECK (json_valid(event_json)),
          PRIMARY KEY (session_id, sequence),
          FOREIGN KEY (session_id) REFERENCES session_streams(session_id) ON DELETE CASCADE
        ) STRICT;
      `);
    }
  }

  append(sessionId: SessionId, expectedVersion: number, newEvents: readonly SessionEvent[]): SessionView {
    this.#assertOpen();
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new RangeError("expectedVersion must be a non-negative integer");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare("SELECT version FROM session_streams WHERE session_id = ?")
        .get(sessionId) as VersionRow | undefined;
      const actualVersion = row?.version ?? 0;

      if (actualVersion !== expectedVersion) {
        throw new ConcurrencyError(expectedVersion, actualVersion);
      }
      if (newEvents.length === 0) {
        if (!row) throw new RangeError("Cannot append an empty batch to a missing Session");
        const existing = this.#readEvents(sessionId, 0);
        const view = replaySession(existing);
        this.#database.exec("COMMIT");
        return view;
      }

      const current = this.#readEvents(sessionId, 0);
      const candidate = [...current, ...structuredClone(newEvents)];
      const view = replaySession(candidate);
      if (view.sessionId !== sessionId) {
        throw new StateTransitionError(
          "STREAM_SESSION_MISMATCH",
          `Cannot store events for ${view.sessionId} under stream ${sessionId}`,
        );
      }

      if (!row) {
        this.#database.prepare("INSERT INTO session_streams (session_id, version) VALUES (?, 0)").run(sessionId);
      }

      const insert = this.#database.prepare(`
        INSERT INTO session_events (session_id, sequence, event_id, event_type, event_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const event of newEvents) {
        insert.run(sessionId, event.sequence, event.eventId, event.type, JSON.stringify(event));
      }

      this.#database
        .prepare("UPDATE session_streams SET version = ? WHERE session_id = ?")
        .run(candidate.length, sessionId);
      this.#database.exec("COMMIT");
      return view;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  read(sessionId: SessionId, afterVersion = 0): EventStream {
    this.#assertOpen();
    if (!Number.isInteger(afterVersion) || afterVersion < 0) {
      throw new RangeError("afterVersion must be a non-negative integer");
    }
    const row = this.#database
      .prepare("SELECT version FROM session_streams WHERE session_id = ?")
      .get(sessionId) as VersionRow | undefined;
    return {
      sessionId,
      version: row?.version ?? 0,
      events: this.#readEvents(sessionId, afterVersion),
    };
  }

  load(sessionId: SessionId): SessionView | undefined {
    const stream = this.read(sessionId);
    return stream.version === 0 ? undefined : replaySession(stream.events);
  }

  listSessions(): SessionSummary[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT streams.session_id,
             streams.version,
             json_extract(created.event_json, '$.data.title') AS title,
             json_extract(latest.event_json, '$.occurredAt') AS updated_at
      FROM session_streams AS streams
      JOIN session_events AS created
        ON created.session_id = streams.session_id AND created.sequence = 1
      JOIN session_events AS latest
        ON latest.session_id = streams.session_id AND latest.sequence = streams.version
      ORDER BY updated_at DESC, streams.session_id ASC
    `).all() as unknown as SessionSummaryRow[];
    return rows.map((row) => ({
      sessionId: row.session_id as SessionId,
      title: row.title ?? row.session_id,
      version: row.version,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #readEvents(sessionId: SessionId, afterVersion: number): SessionEvent[] {
    const rows = this.#database
      .prepare(
        "SELECT event_json FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC",
      )
      .all(sessionId, afterVersion) as unknown as EventRow[];
    return rows.map((row) => parseSessionEvent(JSON.parse(row.event_json)));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SqliteEventStore is closed");
  }
}
