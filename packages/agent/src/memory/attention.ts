import type { EventStore, SessionView } from "@civaapple/qi-agent/kernel";
import { createId, parseSessionEvent, type GoalId, type SessionEvent, type SessionId } from "@civaapple/qi-protocol";

export interface AttentionDecision {
  allowed: boolean;
  reason: string;
}

export class ContinuityController {
  readonly #store: EventStore;
  readonly #sessionId: SessionId;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;

  constructor(store: EventStore, sessionId: SessionId, options: { clock?: () => Date; onEvent?: (event: SessionEvent) => void } = {}) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  setAttentionPolicy(policy: { timezone: string; quietStart: string; quietEnd: string; maxInterruptions: number }, userId: string): void {
    localMinutes(this.#clock(), policy.timezone);
    this.#append("attention.policy.set", policy, { kind: "user", id: userId });
  }

  canInterrupt(now = this.#clock()): AttentionDecision {
    const view = this.#view();
    const policy = view.attentionPolicy;
    if (!policy) return { allowed: false, reason: "No attention policy grants proactive interruption" };
    if (policy.interruptions >= policy.maxInterruptions) return { allowed: false, reason: "Attention budget is exhausted" };
    const minute = localMinutes(now, policy.timezone);
    const start = parseMinute(policy.quietStart);
    const end = parseMinute(policy.quietEnd);
    const quiet = start === end ? true : start < end ? minute >= start && minute < end : minute >= start || minute < end;
    return quiet ? { allowed: false, reason: "Current local time is inside quiet hours" } : { allowed: true, reason: "Outside quiet hours with remaining attention budget" };
  }

  requestAttention(reason: string, goalId?: GoalId, now = this.#clock()): AttentionDecision {
    const decision = this.canInterrupt(now);
    if (!decision.allowed) return decision;
    this.#append("attention.interruption.recorded", { ...(goalId === undefined ? {} : { goalId }), reason }, { kind: "runtime", id: "continuity_controller" });
    return decision;
  }

  presence(state: "active" | "waiting" | "watching" | "sleeping" | "blocked", reason: string, wakeAt?: string): void {
    this.#append("presence.changed", { state, reason, ...(wakeAt === undefined ? {} : { wakeAt }) }, { kind: "runtime", id: "continuity_controller" });
  }

  #view(): SessionView {
    const view = this.#store.load(this.#sessionId);
    if (!view) throw new Error(`Session ${this.#sessionId} does not exist`);
    return view;
  }

  #append(type: SessionEvent["type"], data: unknown, actor: SessionEvent["actor"]): void {
    const stream = this.#store.read(this.#sessionId);
    const event = parseSessionEvent({
      schemaVersion: 1,
      eventId: createId("evt"),
      sessionId: this.#sessionId,
      sequence: stream.version + 1,
      occurredAt: this.#clock().toISOString(),
      actor,
      ...(stream.events.at(-1)?.eventId ? { causationId: stream.events.at(-1)?.eventId } : {}),
      type,
      data,
    });
    this.#store.append(this.#sessionId, stream.version, [event]);
    this.#onEvent?.(event);
  }
}

function localMinutes(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function parseMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new TypeError(`Invalid time ${value}`);
  return (hour ?? 0) * 60 + (minute ?? 0);
}
