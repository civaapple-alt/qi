import type { EventStore } from "@civaapple/qi-agent/kernel";
import type { IndexedMemoryClaim, MemoryController } from "@civaapple/qi-agent/memory";
import type { ActionId, MemoryId, RunId, SessionId } from "@civaapple/qi-protocol";
import { ToolFailure, defineTool } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const MemoryProposalSchema = Type.Object({
  statement: Type.String({ minLength: 1, maxLength: 2_000 }),
  layer: Type.Union([
    Type.Literal("episodic"),
    Type.Literal("semantic"),
    Type.Literal("procedural"),
    Type.Literal("relational"),
  ]),
  scope: Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("user")]),
  sensitivity: Type.Union([Type.Literal("public"), Type.Literal("private"), Type.Literal("secret")]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  source: Type.Union([
    Type.Object({
      kind: Type.Literal("user_input"),
      evidenceQuote: Type.String({ minLength: 1, maxLength: 1_000 }),
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("action_result"),
      actionId: Type.String({ minLength: 1, maxLength: 128 }),
      evidenceQuote: Type.String({ minLength: 1, maxLength: 1_000 }),
    }, { additionalProperties: false }),
  ]),
  expiresAt: Type.Optional(Type.String({ format: "date-time" })),
  contradictionOf: Type.Optional(Type.String({ pattern: "^mem_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" })),
}, { additionalProperties: false });

type MemoryProposal = Static<typeof MemoryProposalSchema>;

export interface MemoryToolDependencies {
  eventStore: EventStore;
  projectId: string;
  projectMemory: MemoryController;
  userMemory: MemoryController;
  autoAcceptProject: boolean;
}

export function createMemoryTool(deps: MemoryToolDependencies) {
  return defineTool({
    description:
      "Propose one durable, reusable memory claim backed by an exact excerpt from the current user input or a " +
      "completed Action result. Do not store transient task state, plans, model conclusions, credentials, tokens, " +
      "or secrets. Qi binds the current Session/Project/User identity; user, sensitive, relational, correction, " +
      "and insufficiently supported claims wait for explicit user confirmation. Memory never grants authority.",
    input: MemoryProposalSchema,
    output: Type.Object({
      memoryId: Type.String(),
      status: Type.Union([Type.Literal("candidate"), Type.Literal("accepted"), Type.Literal("deduplicated")]),
      scope: Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("user")]),
      requiresConfirmation: Type.Boolean(),
    }, { additionalProperties: false }),
    effect: () => "read",
    resources: (input: MemoryProposal) => [`memory:propose:${input.scope}`],
    execute: async (input: MemoryProposal, context) => {
      const reference = resolveSource(deps.eventStore, context.sessionId as SessionId, context.runId as RunId, input);
      const controller = input.scope === "user" ? deps.userMemory : deps.projectMemory;
      const scope = input.scope === "session"
        ? { kind: "session" as const, sessionId: context.sessionId as SessionId }
        : input.scope === "project"
          ? { kind: "project" as const, projectId: deps.projectId }
          : { kind: "user" as const, userId: "local" as const };
      const duplicate = controller.list({
        scopes: [scope],
        statuses: ["candidate", "accepted"],
        limit: 500,
      }).find((claim) => normalize(claim.statement) === normalize(input.statement));
      if (duplicate) {
        return {
          memoryId: duplicate.memoryId,
          status: "deduplicated" as const,
          scope: input.scope,
          requiresConfirmation: duplicate.status !== "accepted",
        };
      }

      const requiresConfirmation = input.scope === "user"
        || input.sensitivity !== "public"
        || input.layer === "relational"
        || input.contradictionOf !== undefined;
      const autoAccept = !requiresConfirmation
        && input.confidence >= 0.8
        && (input.scope === "session" || (input.scope === "project" && deps.autoAcceptProject));
      let claim: IndexedMemoryClaim;
      try {
        claim = controller.propose({
          operationId: `action:${context.actionId}`,
          layer: input.layer,
          statement: input.statement.trim(),
          scope,
          provenance: [{ projectId: deps.projectId, ...reference }],
          confidence: input.confidence,
          sensitivity: input.sensitivity,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.contradictionOf === undefined ? {} : { contradictionOf: input.contradictionOf as MemoryId }),
          requiresConfirmation,
        }, { actorId: "memory_projector", autoAccept });
      } catch (error) {
        throw new ToolFailure(
          "MEMORY_PROPOSAL_REJECTED",
          error instanceof Error ? error.message : "Memory proposal was rejected",
        );
      }
      return {
        memoryId: claim.memoryId,
        status: claim.status === "accepted" ? "accepted" as const : "candidate" as const,
        scope: input.scope,
        requiresConfirmation: claim.status !== "accepted",
      };
    },
  });
}

function resolveSource(
  store: EventStore,
  sessionId: SessionId,
  runId: RunId,
  input: MemoryProposal,
): { sessionId: SessionId; eventId: string; sequence: number } {
  const events = store.read(sessionId).events;
  if (input.source.kind === "user_input") {
    const event = events.find((candidate) =>
      candidate.type === "run.triggered"
      && candidate.data.runId === runId
      && typeof candidate.data.input === "string"
      && candidate.data.input.includes(input.source.evidenceQuote));
    if (!event) throw new ToolFailure("MEMORY_PROVENANCE_MISSING", "Evidence quote is not in the current user input");
    return { sessionId, eventId: event.eventId, sequence: event.sequence };
  }
  const actionId = input.source.actionId as ActionId;
  const event = events.find((candidate) =>
    candidate.type === "action.completed"
    && candidate.data.actionId === actionId
    && JSON.stringify(candidate.data.modelOutput ?? []).includes(input.source.evidenceQuote));
  if (!event) {
    throw new ToolFailure(
      "MEMORY_PROVENANCE_MISSING",
      "Evidence quote is not in a completed Action result from this Session",
    );
  }
  return { sessionId, eventId: event.eventId, sequence: event.sequence };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
