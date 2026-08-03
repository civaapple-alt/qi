import { DatabaseSync } from "node:sqlite";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import {
  ConcurrencyError,
  StateTransitionError,
  applySessionEvent,
  isBootstrapSessionTitle,
  replaySession,
  sessionTitleFromUserInput,
  type EventStore,
  type EventStream,
  type SessionLifecycle,
  type SessionSummary,
  type SessionView,
} from "@civaapple/qi-agent/kernel";

interface VersionRow {
  version: number;
}

interface EventRow {
  event_json: string;
}

interface SessionSummaryRow {
  session_id: string;
  version: number;
  updated_at: string;
  title: string | null;
  first_user_input: string | null;
}

interface LifecycleRow {
  event_type: string;
  event_json: string;
}

/** Lifecycle facts readable without replaying the full Session stream. */
export interface SessionLifecyclePeek {
  readonly lifecycle: SessionLifecycle;
  readonly lifecycleOperationId?: string;
}

const LIFECYCLE_EVENT_TYPES = [
  "session.archive.requested",
  "session.archived",
  "session.restore.requested",
  "session.restored",
] as const;

export interface SqliteEventStoreOptions {
  readonly?: boolean;
}

export class SqliteEventStore implements EventStore {
  readonly #database: DatabaseSync;
  readonly #readonly: boolean;
  readonly #projections = new Map<SessionId, { version: number; view: SessionView }>();
  #closed = false;

  constructor(path: string, options: SqliteEventStoreOptions = {}) {
    this.#readonly = options.readonly ?? false;
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
        this.#projections.delete(sessionId);
        throw new ConcurrencyError(expectedVersion, actualVersion);
      }
      if (newEvents.length === 0) {
        if (!row) throw new RangeError("Cannot append an empty batch to a missing Session");
        const view = this.#projection(sessionId, actualVersion);
        this.#database.exec("COMMIT");
        return view;
      }

      const staged = structuredClone(newEvents);
      let view = actualVersion === 0
        ? undefined
        : this.#projection(sessionId, actualVersion);
      for (const event of staged) view = applySessionEvent(view, event);
      if (!view) throw new StateTransitionError("EMPTY_STREAM", "A Session stream cannot be empty");
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
      for (const event of staged) {
        insert.run(sessionId, event.sequence, event.eventId, event.type, JSON.stringify(event));
      }

      this.#database
        .prepare("UPDATE session_streams SET version = ? WHERE session_id = ?")
        .run(actualVersion + staged.length, sessionId);
      this.#database.exec("COMMIT");
      this.#projections.set(sessionId, { version: actualVersion + staged.length, view });
      return view;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      // A candidate projection may have been mutated before SQLite rejected the
      // batch. Never reuse it after a failed durable append.
      this.#projections.delete(sessionId);
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
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT version FROM session_streams WHERE session_id = ?")
      .get(sessionId) as VersionRow | undefined;
    if (!row || row.version === 0) return undefined;
    return this.#projection(sessionId, row.version);
  }

  /**
   * Catalog listing without full Kernel replay. Bootstrap titles are derived from the
   * first user-triggered Run, matching the Kernel projection. Lifecycle is not included;
   * use `peekLifecycle`.
   */
  listSessions(): SessionSummary[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT streams.session_id,
             streams.version,
             json_extract(latest.event_json, '$.occurredAt') AS updated_at,
             json_extract(created.event_json, '$.data.title') AS title,
             (
               SELECT json_extract(first_run.event_json, '$.data.input')
               FROM session_events AS first_run
               WHERE first_run.session_id = streams.session_id
                 AND first_run.event_type = 'run.triggered'
                 AND json_extract(first_run.event_json, '$.data.trigger') = 'user'
               ORDER BY first_run.sequence ASC
               LIMIT 1
             ) AS first_user_input
      FROM session_streams AS streams
      JOIN session_events AS latest
        ON latest.session_id = streams.session_id AND latest.sequence = streams.version
      LEFT JOIN session_events AS created
        ON created.session_id = streams.session_id AND created.sequence = 1
          AND created.event_type = 'session.created'
      ORDER BY updated_at DESC, streams.session_id ASC
    `).all() as unknown as SessionSummaryRow[];
    return rows.map((row) => {
      const sessionId = row.session_id as SessionId;
      let title = typeof row.title === "string" && row.title.trim() !== "" ? row.title : undefined;
      if (isBootstrapSessionTitle(title) && typeof row.first_user_input === "string") {
        const derived = sessionTitleFromUserInput(row.first_user_input);
        if (derived) title = derived;
      }
      return {
        sessionId,
        title: title ?? sessionId,
        version: row.version,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Read the latest archive/restore lifecycle fact from the append-only stream without
   * projecting the full SessionView. Cold full replay remains the SessionView oracle.
   */
  peekLifecycle(sessionId: SessionId): SessionLifecyclePeek | undefined {
    this.#assertOpen();
    const version = this.#database
      .prepare("SELECT version FROM session_streams WHERE session_id = ?")
      .get(sessionId) as VersionRow | undefined;
    if (!version || version.version === 0) return undefined;
    const placeholders = LIFECYCLE_EVENT_TYPES.map(() => "?").join(", ");
    const row = this.#database.prepare(`
      SELECT event_type, event_json
      FROM session_events
      WHERE session_id = ? AND event_type IN (${placeholders})
      ORDER BY sequence DESC
      LIMIT 1
    `).get(sessionId, ...LIFECYCLE_EVENT_TYPES) as LifecycleRow | undefined;
    if (!row) return { lifecycle: "active" };
    const payload = JSON.parse(row.event_json) as { data?: { operationId?: string } };
    const operationId = typeof payload.data?.operationId === "string" ? payload.data.operationId : undefined;
    switch (row.event_type) {
      case "session.archive.requested":
        return operationId === undefined
          ? { lifecycle: "archive_pending" }
          : { lifecycle: "archive_pending", lifecycleOperationId: operationId };
      case "session.archived":
        return { lifecycle: "archived" };
      case "session.restore.requested":
        return operationId === undefined
          ? { lifecycle: "restore_pending" }
          : { lifecycle: "restore_pending", lifecycleOperationId: operationId };
      case "session.restored":
        return { lifecycle: "active" };
      default:
        return { lifecycle: "active" };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#projections.clear();
    if (!this.#readonly) this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#database.close();
    this.#closed = true;
  }

  checkpoint(): void {
    this.#assertOpen();
    if (!this.#readonly) this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  #readEvents(sessionId: SessionId, afterVersion: number): SessionEvent[] {
    const rows = this.#database
      .prepare(
        "SELECT event_json FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC",
      )
      .all(sessionId, afterVersion) as unknown as EventRow[];
    return rows.map((row) => parseSessionEvent(JSON.parse(row.event_json)));
  }

  #projection(sessionId: SessionId, version: number): SessionView {
    const cached = this.#projections.get(sessionId);
    if (cached?.version === version) return cached.view;
    const view = replaySession(this.#readEvents(sessionId, 0));
    this.#projections.set(sessionId, { version, view });
    return view;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SqliteEventStore is closed");
  }
}
