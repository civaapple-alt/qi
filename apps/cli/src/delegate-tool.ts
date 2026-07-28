import { Coordinator, runDelegatedTurn } from "@civaapple/qi-agent/extensions";
import { GoalEngine } from "@civaapple/qi-agent/eval";
import type { EventStore } from "@civaapple/qi-agent/kernel";
import type { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import type { ModelRef } from "@civaapple/qi-ai";
import type { TurnLoop } from "@civaapple/qi-agent/loop";
import { ToolFailure, defineTool, type ArtifactStore, type ToolRegistry } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const DelegateInputSchema = Type.Object(
  {
    objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    context: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    contextRefs: Type.Optional(
      Type.Array(Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }), { maxItems: 8, uniqueItems: true }),
    ),
    maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    contextTokens: Type.Optional(Type.Integer({ minimum: 512, maximum: 32_000 })),
    wallTimeMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
  },
  { additionalProperties: false },
);

type DelegateInput = Static<typeof DelegateInputSchema>;

export interface DelegateToolDeps {
  eventStore: EventStore;
  broker: InMemoryCapabilityBroker;
  artifactStore: ArtifactStore;
  turnLoop: TurnLoop;
  toolRegistry: ToolRegistry;
  /** Static ModelRef or a resolver so `/login` provider switches apply to child Turns. */
  model: ModelRef | (() => ModelRef);
  workspaceRoot: string;
  parentSubject: string;
  parentLeaseId: string;
  childTools: readonly string[];
}

/** Opt-in parent tool that runs a depth-1 context-isolated Subagent and returns summary/refs only. */
export function createDelegateTool(deps: DelegateToolDeps) {
  return defineTool({
    description:
      "Delegate a bounded subtask to a depth-1 isolated Subagent. Pass only objective and allowlisted context " +
      "(inline context and/or artifact:// refs). The child cannot delegate further. You receive a short summary " +
      "and Artifact refs — never the child transcript. Prefer this when the parent context would otherwise grow " +
      "with exploratory reading.",
    input: DelegateInputSchema,
    output: Type.Object(
      {
        accepted: Type.Boolean(),
        delegationId: Type.String(),
        childSessionId: Type.String(),
        summary: Type.String(),
        summaryRef: Type.Optional(Type.String()),
        resultRef: Type.Optional(Type.String()),
        reasons: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    effect: () => "read",
    resources: () => ["delegation:local"],
    execute: async (input: DelegateInput, context) => {
      const contextRefs = [...(input.contextRefs ?? [])];
      if (input.context) {
        const stored = await deps.artifactStore.put(Buffer.from(input.context, "utf8"), "text/plain; charset=utf-8");
        contextRefs.push(stored.ref);
      }
      if (contextRefs.length === 0) {
        throw new ToolFailure(
          "DELEGATION_CONTEXT_REQUIRED",
          "Provide context and/or contextRefs so the child does not inherit the parent transcript",
        );
      }
      const authorization = ensureDelegationReceipt(
        deps.eventStore,
        context.sessionId,
        deps.parentSubject,
        deps.parentLeaseId,
      );
      const coordinator = new Coordinator({
        store: deps.eventStore,
        broker: deps.broker,
        parentSessionId: context.sessionId as import("@civaapple/qi-protocol").SessionId,
        runId: context.runId as import("@civaapple/qi-protocol").RunId,
        artifactStore: deps.artifactStore,
      });
      const result = await runDelegatedTurn(
        {
          outcome: input.objective,
          deliverableSchema: Type.Object({
            summary: Type.String(),
            status: Type.String(),
          }, { additionalProperties: false }),
          contextRefs,
          parentLeaseId: deps.parentLeaseId,
          childLease: {
            tools: [...deps.childTools],
            effects: ["read"],
            resources: ["file:**", "tree:**", "vcs:."],
            expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
            maxUses: 32,
          },
          resourceEnvelope: {
            contextTokens: input.contextTokens ?? 8_000,
            maxSteps: input.maxSteps ?? 4,
            wallTimeMs: input.wallTimeMs ?? 60_000,
          },
          evidenceRequired: [],
          returnPolicy: "result",
        },
        authorization,
        {
          coordinator,
          turnLoop: deps.turnLoop,
          model: typeof deps.model === "function" ? deps.model() : deps.model,
          workspaceRoot: deps.workspaceRoot,
          artifactStore: deps.artifactStore,
          toolRegistry: deps.toolRegistry,
          input: input.objective,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
      );
      let summary = result.turn.text.trim().slice(0, 2_000);
      if (result.summaryRef) {
        try {
          const stored = await deps.artifactStore.get(result.summaryRef);
          summary = Buffer.from(stored.content).toString("utf8");
        } catch {
          // keep turn text
        }
      }
      return {
        accepted: result.settlement.accepted,
        delegationId: result.handle.delegationId,
        childSessionId: result.handle.childSessionId,
        summary,
        ...(result.summaryRef === undefined ? {} : { summaryRef: result.summaryRef }),
        ...(result.resultRef === undefined ? {} : { resultRef: result.resultRef }),
        reasons: result.settlement.reasons,
      };
    },
  });
}

function ensureDelegationReceipt(
  store: EventStore,
  sessionId: string,
  subject: string,
  parentLeaseId: string,
): { receiptId: string; parentSubject: string } {
  const view = store.load(sessionId as import("@civaapple/qi-protocol").SessionId);
  if (!view) throw new ToolFailure("SESSION_MISSING", `Session ${sessionId} does not exist`);
  const existing = Object.values(view.controlReceipts).find(
    (receipt) =>
      receipt.phase === "granted" &&
      receipt.delegationRight &&
      (receipt.issuedTo === subject || receipt.issuedTo === "user"),
  );
  if (existing) return { receiptId: existing.receiptId, parentSubject: subject };

  const activeGoal = view.currentGoalId ? view.goals[view.currentGoalId] : undefined;
  if (activeGoal?.state === "active") {
    throw new ToolFailure(
      "DELEGATION_RECEIPT_UNAVAILABLE",
      "An active Goal exists without a delegation-right Control Receipt",
    );
  }

  const goals = new GoalEngine(store, sessionId as import("@civaapple/qi-protocol").SessionId);
  const goal = goals.create(
    {
      objective: "Authorize depth-1 Subagent delegation for this Session",
      assertions: [{ assertionId: "delegation.authorized", description: "Delegation right granted" }],
      boundaries: ["depth=1", "contextRefs-only", "no child delegate"],
    },
    {
      issuedTo: subject,
      startRight: "user",
      stopRight: "contract",
      acceptanceRight: "human",
      delegationRight: true,
      actionLeaseIds: [parentLeaseId],
    },
  );
  const receipt = Object.values(store.load(sessionId as import("@civaapple/qi-protocol").SessionId)!.controlReceipts)
    .find((item) => item.goalId === goal.goalId && item.phase === "granted" && item.delegationRight);
  if (!receipt) throw new ToolFailure("DELEGATION_RECEIPT_MISSING", "Failed to issue delegation Control Receipt");
  return { receiptId: receipt.receiptId, parentSubject: subject };
}
