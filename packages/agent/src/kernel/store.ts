import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { ConcurrencyError, StateTransitionError } from "./errors.js";
import { replaySession, type SessionView } from "./projection.js";

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

  append(sessionId: SessionId, expectedVersion: number, newEvents: readonly SessionEvent[]): SessionView {
    const current = this.#streams.get(sessionId) ?? [];
    if (current.length !== expectedVersion) {
      throw new ConcurrencyError(expectedVersion, current.length);
    }
    if (newEvents.length === 0) {
      if (current.length === 0) throw new RangeError("Cannot append an empty batch to a missing Session");
      return replaySession(current);
    }

    const candidate = [...current, ...structuredClone(newEvents)];
    const view = replaySession(candidate);
    if (view.sessionId !== sessionId) {
      throw new StateTransitionError(
        "STREAM_SESSION_MISMATCH",
        `Cannot store events for ${view.sessionId} under stream ${sessionId}`,
      );
    }
    this.#streams.set(sessionId, candidate);
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
    return current ? replaySession(current) : undefined;
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
}

function compareSessionSummary(left: SessionSummary, right: SessionSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId);
}
