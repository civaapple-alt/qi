import type { SessionId } from "@civaapple/qi-protocol";

export interface SteeringMessage {
  message: string;
  actorId: string;
  enqueuedAt: string;
}

export class SteeringMailbox {
  readonly #messages = new Map<SessionId, SteeringMessage[]>();

  enqueue(sessionId: SessionId, message: string, actorId = "user"): void {
    if (!message.trim()) throw new TypeError("Steering message cannot be empty");
    const queue = this.#messages.get(sessionId) ?? [];
    queue.push({ message, actorId, enqueuedAt: new Date().toISOString() });
    this.#messages.set(sessionId, queue);
  }

  drain(sessionId: SessionId): SteeringMessage[] {
    const queue = this.#messages.get(sessionId) ?? [];
    this.#messages.delete(sessionId);
    return queue.map((message) => ({ ...message }));
  }

  size(sessionId: SessionId): number {
    return this.#messages.get(sessionId)?.length ?? 0;
  }
}
