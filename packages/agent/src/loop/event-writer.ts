import { redactSensitiveValue, type RedactionSummary } from "@civaapple/qi-agent/capability";
import { createId, parseSessionEvent, type SessionEvent, type SessionId } from "@civaapple/qi-protocol";
import type { EventStore, SessionView } from "@civaapple/qi-agent/kernel";

export interface EventActor {
  kind: "user" | "agent" | "runtime" | "evaluator";
  id: string;
}

export interface EventBatchEntry {
  type: SessionEvent["type"];
  data: unknown;
  actor: EventActor;
}

export class EventWriter {
  readonly #store: EventStore;
  readonly #sessionId: SessionId;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;
  #version: number;
  #lastEventId: string | undefined;
  #view: SessionView | undefined;

  constructor(
    store: EventStore,
    sessionId: SessionId,
    clock: () => Date = () => new Date(),
    onEvent?: (event: SessionEvent) => void,
  ) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.#clock = clock;
    this.#onEvent = onEvent;
    const stream = store.read(sessionId);
    this.#version = stream.version;
    this.#lastEventId = stream.events.at(-1)?.eventId;
    this.#view = store.load(sessionId);
  }

  get view(): SessionView | undefined {
    return this.#view;
  }

  append(type: SessionEvent["type"], data: unknown, actor: EventActor): SessionEvent {
    const events = this.appendBatch([{ type, data, actor }]);
    const primary = events.find((event) => event.type === type);
    if (!primary) throw new Error(`appendBatch did not produce ${type}`);
    return primary;
  }

  /** Append one or more events in a single EventStore transaction (atomic replay). */
  appendBatch(entries: readonly EventBatchEntry[]): SessionEvent[] {
    if (entries.length === 0) return [];
    this.#refreshIfStale();
    const built: SessionEvent[] = [];
    let sequence = this.#version;
    let causationId = this.#lastEventId;
    const occurredAt = this.#clock().toISOString();

    for (const entry of entries) {
      const sanitized = redactSensitiveValue(entry.data);
      if (entry.type !== "safety.redaction.applied" && sanitized.redactions.length > 0) {
        if (entry.type !== "session.created") {
          const audit = this.#buildEvent(
            "safety.redaction.applied",
            {
              boundary: "event-store",
              sourceEventType: entry.type,
              ...eventRefs(sanitized.value),
              redactions: [...sanitized.redactions],
            },
            { kind: "runtime", id: "safety_filter" },
            ++sequence,
            occurredAt,
            causationId,
          );
          built.push(audit);
          causationId = audit.eventId;
        }
      }
      const event = this.#buildEvent(entry.type, sanitized.value, entry.actor, ++sequence, occurredAt, causationId);
      built.push(event);
      causationId = event.eventId;
      if (entry.type === "session.created" && sanitized.redactions.length > 0) {
        const audit = this.#buildEvent(
          "safety.redaction.applied",
          {
            boundary: "event-store",
            sourceEventType: entry.type,
            ...eventRefs(sanitized.value),
            redactions: [...sanitized.redactions],
          },
          { kind: "runtime", id: "safety_filter" },
          ++sequence,
          occurredAt,
          causationId,
        );
        built.push(audit);
        causationId = audit.eventId;
      }
    }

    this.#view = this.#store.append(this.#sessionId, this.#version, built);
    this.#version += built.length;
    this.#lastEventId = built.at(-1)?.eventId;
    for (const event of built) this.#onEvent?.(event);
    return built;
  }

  #buildEvent(
    type: SessionEvent["type"],
    data: unknown,
    actor: EventActor,
    sequence: number,
    occurredAt: string,
    causationId: string | undefined,
  ): SessionEvent {
    return parseSessionEvent({
      schemaVersion: 1,
      eventId: createId("evt"),
      sessionId: this.#sessionId,
      sequence,
      occurredAt,
      actor,
      ...(causationId === undefined ? {} : { causationId }),
      type,
      data,
    });
  }

  #refreshIfStale(): void {
    const stream = this.#store.read(this.#sessionId);
    if (stream.version === this.#version) return;
    this.#version = stream.version;
    this.#lastEventId = stream.events.at(-1)?.eventId;
    this.#view = this.#store.load(this.#sessionId);
  }
}

function eventRefs(data: unknown): { runId?: string; stepId?: string; actionId?: string } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const value = data as Record<string, unknown>;
  return {
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.stepId === "string" ? { stepId: value.stepId } : {}),
    ...(typeof value.actionId === "string" ? { actionId: value.actionId } : {}),
  };
}
