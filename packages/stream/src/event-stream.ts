import type { EventStore } from "@civaapple/qi-kernel";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";

interface Subscriber {
  queue: SessionEvent[];
  waiting: (() => void) | undefined;
  closed: boolean;
  error: Error | undefined;
}

export interface EventSubscription extends AsyncIterable<SessionEvent> {
  close(): void;
}

export class SessionEventHub {
  readonly #subscribers = new Map<SessionId, Set<Subscriber>>();
  readonly #maximumQueue: number;

  constructor(maximumQueue = 1_000) {
    if (!Number.isInteger(maximumQueue) || maximumQueue <= 0) {
      throw new RangeError("maximumQueue must be a positive integer");
    }
    this.#maximumQueue = maximumQueue;
  }

  publish(event: SessionEvent): void {
    for (const subscriber of this.#subscribers.get(event.sessionId) ?? []) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length === this.#maximumQueue) {
        subscriber.error = new Error(`Session event subscriber overflowed ${this.#maximumQueue} queued events`);
        subscriber.closed = true;
        subscriber.waiting?.();
        continue;
      }
      subscriber.queue.push(structuredClone(event));
      subscriber.waiting?.();
      subscriber.waiting = undefined;
    }
  }

  subscribe(sessionId: SessionId, signal?: AbortSignal): EventSubscription {
    const subscriber: Subscriber = { queue: [], waiting: undefined, closed: false, error: undefined };
    const subscribers = this.#subscribers.get(sessionId) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(sessionId, subscribers);

    const close = () => {
      if (subscriber.closed && !subscribers.has(subscriber)) return;
      subscriber.closed = true;
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(sessionId);
      subscriber.waiting?.();
      subscriber.waiting = undefined;
    };
    signal?.addEventListener("abort", close, { once: true });

    return {
      close,
      [Symbol.asyncIterator]: async function* () {
        try {
          while (true) {
            if (subscriber.error) throw subscriber.error;
            const event = subscriber.queue.shift();
            if (event) {
              yield event;
              continue;
            }
            if (subscriber.closed || signal?.aborted) return;
            await new Promise<void>((resolve) => {
              subscriber.waiting = resolve;
            });
          }
        } finally {
          signal?.removeEventListener("abort", close);
          close();
        }
      },
    };
  }
}

export class EventStreamService {
  readonly #store: EventStore;
  readonly #hub: SessionEventHub;

  constructor(store: EventStore, hub: SessionEventHub) {
    this.#store = store;
    this.#hub = hub;
  }

  async *events(sessionId: SessionId, afterSequence = 0, signal?: AbortSignal): AsyncIterable<SessionEvent> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative integer");
    }

    const live = this.#hub.subscribe(sessionId, signal);
    let cursor = afterSequence;
    try {
      for (const event of this.#store.read(sessionId, afterSequence).events) {
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield event;
      }
      for await (const event of live) {
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield event;
      }
    } finally {
      live.close();
    }
  }
}

export function encodeSseEvent(event: SessionEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function* sseStream(events: AsyncIterable<SessionEvent>): AsyncIterable<string> {
  for await (const event of events) yield encodeSseEvent(event);
}
