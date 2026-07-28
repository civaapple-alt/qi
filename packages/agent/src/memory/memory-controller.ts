import type { ContextBlock } from "@civaapple/qi-ai/context";
import type { EventStore, MemoryLayer } from "@civaapple/qi-agent/kernel";
import { createId, parseSessionEvent, type MemoryId, type SessionEvent, type SessionId } from "@civaapple/qi-protocol";
import type {
  IndexedMemoryClaim,
  MemoryIndex,
  MemorySearchOptions,
} from "./memory-index.js";

export interface MemoryCandidateInput {
  layer: MemoryLayer;
  statement: string;
  scope: string;
  provenance: readonly { sessionId: SessionId; eventId: string; sequence: number }[];
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  validFrom?: string;
  expiresAt?: string;
  contradictionOf?: MemoryId;
  requiresConfirmation?: boolean;
}

export class MemoryController {
  readonly #store: EventStore;
  readonly #index: MemoryIndex;
  readonly #sessionId: SessionId;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;

  constructor(
    store: EventStore,
    index: MemoryIndex,
    sessionId: SessionId,
    options: { clock?: () => Date; onEvent?: (event: SessionEvent) => void } = {},
  ) {
    if (!store.load(sessionId)) throw new Error(`Session ${sessionId} does not exist`);
    this.#store = store;
    this.#index = index;
    this.#sessionId = sessionId;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  candidate(input: MemoryCandidateInput, actorId = "memory_projector"): MemoryId {
    for (const reference of input.provenance) this.#assertProvenance(reference);
    const memoryId = createId("mem") as MemoryId;
    const requiresConfirmation = input.requiresConfirmation ??
      (input.layer === "relational" || input.sensitivity !== "public" || input.scope.startsWith("global:"));
    this.#append(this.#sessionId, "memory.candidate.created", {
      memoryId,
      layer: input.layer,
      statement: input.statement,
      scope: input.scope,
      provenance: input.provenance.map((reference) => ({ ...reference })),
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      validFrom: input.validFrom ?? this.#clock().toISOString(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.contradictionOf === undefined ? {} : { contradictionOf: input.contradictionOf }),
      requiresConfirmation,
    }, { kind: "agent", id: actorId });
    return memoryId;
  }

  accept(memoryId: MemoryId, actor: { kind: "user" | "runtime" | "evaluator"; id: string }): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    this.#append(claim.originSessionId, "memory.accepted", { memoryId, confirmedBy: actor.id }, actor);
    return this.#required(memoryId);
  }

  dispute(memoryId: MemoryId, reason: string, actorId: string, correctionMemoryId?: MemoryId): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    this.#append(claim.originSessionId, "memory.disputed", {
      memoryId,
      reason,
      ...(correctionMemoryId === undefined ? {} : { correctionMemoryId }),
    }, { kind: "user", id: actorId });
    return this.#required(memoryId);
  }

  forget(memoryId: MemoryId, reason: string, actorId: string): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    this.#append(claim.originSessionId, "memory.forgotten", { memoryId, reason }, { kind: "user", id: actorId });
    return this.#required(memoryId);
  }

  correct(memoryId: MemoryId, replacement: Omit<MemoryCandidateInput, "scope" | "contradictionOf">, actorId: string): IndexedMemoryClaim {
    const previous = this.#required(memoryId);
    const correctionId = this.candidate({ ...replacement, scope: previous.scope, contradictionOf: memoryId, requiresConfirmation: true });
    this.accept(correctionId, { kind: "user", id: actorId });
    this.dispute(memoryId, "Superseded by an explicit correction", actorId, correctionId);
    return this.#required(correctionId);
  }

  retrieve(options: MemorySearchOptions): IndexedMemoryClaim[] {
    return this.#index.search(options);
  }

  contextBlocks(options: MemorySearchOptions, priority = 60): ContextBlock[] {
    return this.retrieve(options).map((claim) => ({
      id: `memory:${claim.memoryId}`,
      kind: "memory",
      source: `memory:${claim.memoryId}`,
      role: "system",
      content: claim.statement,
      priority,
      required: false,
      retentionReason: `Accepted ${claim.layer} memory from ${claim.provenance.map((ref) => `${ref.sessionId}#${ref.sequence}`).join(", ")}`,
    }));
  }

  #required(memoryId: MemoryId): IndexedMemoryClaim {
    const claim = this.#index.get(memoryId);
    if (!claim) throw new Error(`Memory ${memoryId} does not exist`);
    return claim;
  }

  #assertProvenance(reference: { sessionId: SessionId; eventId: string; sequence: number }): void {
    const event = this.#store.read(reference.sessionId).events.find(
      (candidate) => candidate.eventId === reference.eventId && candidate.sequence === reference.sequence,
    );
    if (!event) throw new Error(`Memory provenance ${reference.sessionId}#${reference.sequence} is missing`);
  }

  #append(sessionId: SessionId, type: SessionEvent["type"], data: unknown, actor: SessionEvent["actor"]): SessionEvent {
    const stream = this.#store.read(sessionId);
    const event = parseSessionEvent({
      schemaVersion: 1,
      eventId: createId("evt"),
      sessionId,
      sequence: stream.version + 1,
      occurredAt: this.#clock().toISOString(),
      actor,
      ...(stream.events.at(-1)?.eventId ? { causationId: stream.events.at(-1)?.eventId } : {}),
      type,
      data,
    });
    this.#store.append(sessionId, stream.version, [event]);
    this.#index.apply(event);
    this.#onEvent?.(event);
    return event;
  }
}
