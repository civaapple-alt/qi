import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { ConcurrencyError, StateTransitionError } from "./errors.js";
import { applySessionEvent, replaySession, type SessionView } from "./projection.js";

export interface EventStream {
  sessionId: SessionId;
  version: number;
  events: SessionEvent[];
}

export interface SessionSummary {
  sessionId: SessionId;
  title: string;
  version: number;
  updatedAt: string;
}

export interface EventStore {
  append(sessionId: SessionId, expectedVersion: number, newEvents: readonly SessionEvent[]): SessionView;
  read(sessionId: SessionId, afterVersion?: number): EventStream;
  load(sessionId: SessionId): SessionView | undefined;
  listSessions(): SessionSummary[];
}

export class InMemoryEventStore implements EventStore {
  readonly #streams = new Map<SessionId, SessionEvent[]>();
  readonly #projections = new Map<SessionId, { version: number; view: SessionView }>();

  append(sessionId: SessionId, expectedVersion: number, newEvents: readonly SessionEvent[]): SessionView {
    const current = this.#streams.get(sessionId) ?? [];
    if (current.length !== expectedVersion) {
      throw new ConcurrencyError(expectedVersion, current.length);
    }
    if (newEvents.length === 0) {
      if (current.length === 0) throw new RangeError("Cannot append an empty batch to a missing Session");
      return this.load(sessionId)!;
    }

    const staged = structuredClone(newEvents);
    let view: SessionView | undefined = current.length === 0
      ? undefined
      : this.#projection(sessionId, current);
    try {
      for (const event of staged) view = applySessionEvent(view, event);
      if (!view) throw new StateTransitionError("EMPTY_STREAM", "A Session stream cannot be empty");
      if (view.sessionId !== sessionId) {
        throw new StateTransitionError(
          "STREAM_SESSION_MISMATCH",
          `Cannot store events for ${view.sessionId} under stream ${sessionId}`,
        );
      }
    } catch (error) {
      // applySessionEvent mutates a cached projection. The durable stream is
      // unchanged on failure, so discard the candidate and rebuild on demand.
      this.#projections.delete(sessionId);
      throw error;
    }
    current.push(...staged);
    this.#streams.set(sessionId, current);
    this.#projections.set(sessionId, { version: current.length, view });
    return view;
  }

  read(sessionId: SessionId, afterVersion = 0): EventStream {
    if (!Number.isInteger(afterVersion) || afterVersion < 0) {
      throw new RangeError("afterVersion must be a non-negative integer");
    }
    const current = this.#streams.get(sessionId) ?? [];
    return {
      sessionId,
      version: current.length,
      events: structuredClone(current.slice(afterVersion)),
    };
  }

  load(sessionId: SessionId): SessionView | undefined {
    const current = this.#streams.get(sessionId);
    if (!current) return undefined;
    return this.#projection(sessionId, current);
  }

  listSessions(): SessionSummary[] {
    return [...this.#streams.entries()]
      .map(([sessionId, events]) => {
        const view = replaySession(events);
        return {
          sessionId,
          title: view.title ?? sessionId,
          version: events.length,
          updatedAt: events.at(-1)?.occurredAt ?? events[0]?.occurredAt ?? "",
        };
      })
      .sort(compareSessionSummary);
  }

  #projection(sessionId: SessionId, events: readonly SessionEvent[]): SessionView {
    const cached = this.#projections.get(sessionId);
    if (cached?.version === events.length) return cached.view;
    const view = replaySession(events);
    this.#projections.set(sessionId, { version: events.length, view });
    return view;
  }
}

function compareSessionSummary(left: SessionSummary, right: SessionSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId);
}
