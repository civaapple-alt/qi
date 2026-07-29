import type { ContextBlock } from "@civaapple/qi-ai/context";
import { redactSensitiveValue } from "@civaapple/qi-agent/capability";
import { ConcurrencyError, type EventStore, type MemoryLayer } from "@civaapple/qi-agent/kernel";
import {
  createId,
  parseSessionEvent,
  type MemoryActivation,
  type MemoryId,
  type MemoryScope,
  type SessionEvent,
  type SessionId,
} from "@civaapple/qi-protocol";
import type {
  CompatibleMemoryScope,
  IndexedMemoryClaim,
  MemoryIndex,
  MemoryListOptions,
  MemorySearchOptions,
} from "./memory-index.js";

export interface MemoryProvenanceReference {
  projectId?: string;
  sessionId: SessionId;
  eventId: string;
  sequence: number;
}

export interface ProvenanceResolver {
  resolve(reference: MemoryProvenanceReference): SessionEvent | undefined;
}

export interface MemoryCandidateInput {
  layer: MemoryLayer;
  statement: string;
  scope: CompatibleMemoryScope;
  provenance: readonly MemoryProvenanceReference[];
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  validFrom?: string;
  expiresAt?: string;
  contradictionOf?: MemoryId;
  derivedFromMemoryId?: MemoryId;
  requiresConfirmation?: boolean;
  operationId?: string;
}

export class MemoryIndexPendingError extends Error {
  readonly code = "MEMORY_INDEX_PENDING";

  constructor() {
    super("Memory was recorded and will be indexed during startup recovery");
    this.name = "MemoryIndexPendingError";
  }
}

export class MemoryController {
  readonly #store: EventStore;
  readonly #index: MemoryIndex;
  readonly #sessionId: SessionId;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;
  readonly #provenanceResolver: ProvenanceResolver;

  constructor(
    store: EventStore,
    index: MemoryIndex,
    sessionId: SessionId,
    options: {
      clock?: () => Date;
      onEvent?: (event: SessionEvent) => void;
      provenanceResolver?: ProvenanceResolver;
    } = {},
  ) {
    this.#store = store;
    this.#index = index;
    this.#sessionId = sessionId;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
    this.#provenanceResolver = options.provenanceResolver ?? {
      resolve: (reference) => this.#store.read(reference.sessionId).events.find(
        (candidate) => candidate.eventId === reference.eventId && candidate.sequence === reference.sequence,
      ),
    };
  }

  candidate(input: MemoryCandidateInput, actorId = "memory_projector"): MemoryId {
    const existing = input.operationId === undefined ? undefined : this.#findByOperation(input.operationId);
    if (existing) return existing.memoryId;
    const originSessionId = input.contradictionOf === undefined
      ? this.#sessionId
      : this.#required(input.contradictionOf).originSessionId;
    return this.#candidateAt(originSessionId, input, actorId);
  }

  propose(
    input: MemoryCandidateInput,
    options: { actorId?: string; autoAccept?: boolean } = {},
  ): IndexedMemoryClaim {
    const existing = input.operationId === undefined ? undefined : this.#findByOperation(input.operationId);
    if (existing) return existing;
    const memoryId = createId("mem") as MemoryId;
    const entry = this.#candidateEntry(memoryId, input, options.actorId ?? "memory_projector");
    const entries = options.autoAccept
      ? [
          entry,
          {
            type: "memory.accepted" as const,
            data: { memoryId, confirmedBy: options.actorId ?? "memory_projector" },
            actor: { kind: "runtime" as const, id: options.actorId ?? "memory_projector" },
          },
        ]
      : [entry];
    const originSessionId = input.contradictionOf === undefined
      ? this.#sessionId
      : this.#required(input.contradictionOf).originSessionId;
    this.#appendBatch(originSessionId, entries);
    return this.#required(memoryId);
  }

  #candidateAt(sessionId: SessionId, input: MemoryCandidateInput, actorId: string): MemoryId {
    const memoryId = createId("mem") as MemoryId;
    this.#appendBatch(sessionId, [this.#candidateEntry(memoryId, input, actorId)]);
    return memoryId;
  }

  #candidateEntry(memoryId: MemoryId, input: MemoryCandidateInput, actorId: string) {
    for (const reference of input.provenance) this.#assertProvenance(reference, input.scope);
    const redacted = redactSensitiveValue(input.statement);
    if (redacted.redactions.length > 0) {
      throw new Error("Memory statement contains credential-like secret material and cannot be persisted");
    }
    const requiresConfirmation = input.requiresConfirmation ??
      (input.layer === "relational"
        || input.sensitivity !== "public"
        || (typeof input.scope !== "string" && input.scope.kind === "user")
        || (typeof input.scope === "string" && input.scope.startsWith("global:")));
    return {
      type: "memory.candidate.created" as const,
      data: {
        memoryId,
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        layer: input.layer,
        statement: input.statement,
        scope: typeof input.scope === "string" ? input.scope : { ...input.scope },
        provenance: input.provenance.map((reference) => ({ ...reference })),
        confidence: input.confidence,
        sensitivity: input.sensitivity,
        validFrom: input.validFrom ?? this.#clock().toISOString(),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.contradictionOf === undefined ? {} : { contradictionOf: input.contradictionOf }),
        ...(input.derivedFromMemoryId === undefined ? {} : { derivedFromMemoryId: input.derivedFromMemoryId }),
        requiresConfirmation,
      },
      actor: { kind: "agent" as const, id: actorId },
    };
  }

  accept(memoryId: MemoryId, actor: { kind: "user" | "runtime" | "evaluator"; id: string }): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    const correction = claim.contradictionOf === undefined ? undefined : this.#required(claim.contradictionOf);
    if (correction && correction.status !== "accepted") {
      throw new Error(`Memory ${correction.memoryId} is already ${correction.status}`);
    }
    this.#appendBatch(claim.originSessionId, [
      {
        type: "memory.accepted",
        data: { memoryId, confirmedBy: actor.id },
        actor,
      },
      ...(correction === undefined
        ? []
        : [{
            type: "memory.disputed" as const,
            data: {
              memoryId: correction.memoryId,
              reason: "Superseded by an explicitly accepted correction",
              correctionMemoryId: memoryId,
            },
            actor: { kind: "user" as const, id: actor.id },
          }]),
    ]);
    return this.#required(memoryId);
  }

  dispute(memoryId: MemoryId, reason: string, actorId: string, correctionMemoryId?: MemoryId): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    this.#appendBatch(claim.originSessionId, [{
      type: "memory.disputed",
      data: {
        memoryId,
        reason,
        ...(correctionMemoryId === undefined ? {} : { correctionMemoryId }),
      },
      actor: { kind: "user", id: actorId },
    }]);
    return this.#required(memoryId);
  }

  forget(memoryId: MemoryId, reason: string, actorId: string): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    this.#appendBatch(claim.originSessionId, [{
      type: "memory.forgotten",
      data: { memoryId, reason },
      actor: { kind: "user", id: actorId },
    }]);
    return this.#required(memoryId);
  }

  correct(memoryId: MemoryId, replacement: Omit<MemoryCandidateInput, "scope" | "contradictionOf">, actorId: string): IndexedMemoryClaim {
    const previous = this.#required(memoryId);
    const operationId = replacement.operationId ??
      `correct:${memoryId}:${replacement.provenance[0]?.eventId ?? replacement.statement}`;
    const existing = this.#findByOperation(operationId);
    if (existing) return existing;
    const correctionId = createId("mem") as MemoryId;
    const candidate = this.#candidateEntry(correctionId, {
      ...replacement,
      operationId,
      scope: previous.scope,
      contradictionOf: memoryId,
      requiresConfirmation: true,
    }, actorId);
    this.#appendBatch(previous.originSessionId, [
      candidate,
      {
        type: "memory.accepted",
        data: { memoryId: correctionId, confirmedBy: actorId },
        actor: { kind: "user", id: actorId },
      },
      {
        type: "memory.disputed",
        data: {
          memoryId,
          reason: "Superseded by an explicit correction",
          correctionMemoryId: correctionId,
        },
        actor: { kind: "user", id: actorId },
      },
    ]);
    return this.#required(correctionId);
  }

  setActivation(memoryId: MemoryId, activation: MemoryActivation, actorId: string): IndexedMemoryClaim {
    const claim = this.#required(memoryId);
    this.#appendBatch(claim.originSessionId, [{
      type: "memory.activation.changed",
      data: { memoryId, activation },
      actor: { kind: "user", id: actorId },
    }]);
    return this.#required(memoryId);
  }

  retrieve(options: MemorySearchOptions): IndexedMemoryClaim[] {
    return this.#index.search(options);
  }

  list(options: MemoryListOptions = {}): IndexedMemoryClaim[] {
    return this.#index.list(options);
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

  #assertProvenance(reference: MemoryProvenanceReference, scope: CompatibleMemoryScope): void {
    const event = this.#provenanceResolver.resolve(reference);
    if (!event) throw new Error(`Memory provenance ${reference.sessionId}#${reference.sequence} is missing`);
    if (typeof scope === "string") return;
    const allowed =
      (event.type === "run.triggered" && event.actor.kind === "user" && typeof event.data.input === "string")
      || event.type === "action.completed"
      || (event.type === "memory.user.asserted" && event.actor.kind === "user");
    if (!allowed) {
      throw new Error(
        `Memory provenance ${reference.sessionId}#${reference.sequence} is not a user input, completed Action, or user Memory assertion`,
      );
    }
  }

  #findByOperation(operationId: string): IndexedMemoryClaim | undefined {
    const projected = this.#index.findByOperation(operationId);
    if (projected) return projected;
    for (const session of this.#store.listSessions()) {
      const events = this.#store.read(session.sessionId).events;
      const candidate = events.find(
        (event) => event.type === "memory.candidate.created" && event.data.operationId === operationId,
      );
      if (!candidate || candidate.type !== "memory.candidate.created") continue;
      try {
        this.#index.applyBatch(events);
      } catch {
        throw new MemoryIndexPendingError();
      }
      const recovered = this.#index.get(candidate.data.memoryId);
      if (!recovered) throw new MemoryIndexPendingError();
      return recovered;
    }
    return undefined;
  }

  #appendBatch(
    sessionId: SessionId,
    entries: readonly { type: SessionEvent["type"]; data: unknown; actor: SessionEvent["actor"] }[],
  ): SessionEvent[] {
    const occurredAt = this.#clock().toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = this.#store.read(sessionId);
      let causationId = stream.events.at(-1)?.eventId;
      const events = entries.map((entry, index) => {
        const event = parseSessionEvent({
          schemaVersion: 1,
          eventId: createId("evt"),
          sessionId,
          sequence: stream.version + index + 1,
          occurredAt,
          actor: entry.actor,
          ...(causationId ? { causationId } : {}),
          type: entry.type,
          data: entry.data,
        });
        causationId = event.eventId;
        return event;
      });
      try {
        this.#store.append(sessionId, stream.version, events);
      } catch (error) {
        if (error instanceof ConcurrencyError && attempt < 2) continue;
        throw error;
      }
      try {
        this.#index.applyBatch(events);
      } catch {
        for (const event of events) this.#onEvent?.(event);
        throw new MemoryIndexPendingError();
      }
      for (const event of events) this.#onEvent?.(event);
      return events;
    }
    throw new Error("Memory append retry limit exhausted");
  }
}
