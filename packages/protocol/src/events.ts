import { Type, type Static, type TObject, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ActionIdSchema,
  EvaluationIdSchema,
  EvidenceIdSchema,
  EventIdSchema,
  GoalIdSchema,
  LeaseIdSchema,
  MemoryIdSchema,
  PlanIdSchema,
  PlanItemIdSchema,
  QuestionIdSchema,
  RunIdSchema,
  ReceiptIdSchema,
  SessionIdSchema,
  StepIdSchema,
  TaskIdSchema,
} from "./ids.js";

const isoTimestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const sha256Pattern = "^[a-f0-9]{64}$";

const ActorSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("user"),
      Type.Literal("agent"),
      Type.Literal("runtime"),
      Type.Literal("evaluator"),
    ]),
    id: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

const envelope = {
  schemaVersion: Type.Literal(1),
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  sequence: Type.Integer({ minimum: 1 }),
  occurredAt: Type.String({ pattern: isoTimestampPattern }),
  actor: ActorSchema,
  causationId: Type.Optional(EventIdSchema),
  correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
} as const;

function event<const Kind extends string, Data extends TObject | TSchema>(kind: Kind, data: Data) {
  return Type.Object(
    {
      ...envelope,
      type: Type.Literal(kind),
      data,
    },
    { additionalProperties: false },
  );
}

const RunRef = Type.Object({ runId: RunIdSchema }, { additionalProperties: false });
const StepRef = Type.Object({ runId: RunIdSchema, stepId: StepIdSchema }, { additionalProperties: false });
const ActionRef = Type.Object(
  { runId: RunIdSchema, stepId: StepIdSchema, actionId: ActionIdSchema },
  { additionalProperties: false },
);

const ResourceNameSchema = Type.Union([
  Type.Literal("token"),
  Type.Literal("wallTime"),
  Type.Literal("money"),
  Type.Literal("attempts"),
  Type.Literal("concurrency"),
  Type.Literal("context"),
  Type.Literal("risk"),
  Type.Literal("attention"),
]);

const GoalStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("blocked"),
  Type.Literal("complete"),
  Type.Literal("cancelled"),
]);

export const SessionModeSchema = Type.Union([
  Type.Literal("ask"),
  Type.Literal("plan"),
  Type.Literal("agent"),
]);

const PlanItemSchema = Type.Object(
  {
    planItemId: PlanItemIdSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 4_000 }),
    verification: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    dependsOn: Type.Optional(Type.Array(PlanItemIdSchema, { maxItems: 32, uniqueItems: true })),
  },
  { additionalProperties: false },
);

const PlanBindingSchema = Type.Object(
  {
    planId: PlanIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    planItemId: PlanItemIdSchema,
    continuationOf: Type.Optional(RunIdSchema),
  },
  { additionalProperties: false },
);

export const SessionEventSchema = Type.Union([
  event(
    "session.created",
    Type.Object(
      {
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        mode: Type.Optional(SessionModeSchema),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "session.mode.changed",
    Type.Object(
      {
        from: SessionModeSchema,
        to: SessionModeSchema,
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "workspace.mount.added",
    Type.Object(
      {
        mountId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
        path: Type.String({ minLength: 1, maxLength: 4_000 }),
        mode: Type.Literal("read"),
        source: Type.Union([
          Type.Literal("project_config"),
          Type.Literal("cli"),
          Type.Literal("grant"),
          Type.Literal("command"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "workspace.mount.removed",
    Type.Object(
      {
        mountId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "plan.revision.recorded",
    Type.Object(
      {
        planId: PlanIdSchema,
        revision: Type.Integer({ minimum: 1 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        overview: Type.String({ minLength: 1, maxLength: 8_000 }),
        artifactRef: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
        sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        path: Type.String({ minLength: 1, maxLength: 500 }),
        items: Type.Array(PlanItemSchema, { minItems: 1, maxItems: 64 }),
        sourceRunId: Type.Optional(RunIdSchema),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "plan.review.requested",
    Type.Object(
      {
        planId: PlanIdSchema,
        revision: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "plan.review.settled",
    Type.Object(
      {
        planId: PlanIdSchema,
        revision: Type.Integer({ minimum: 1 }),
        decision: Type.Union([
          Type.Literal("accepted"),
          Type.Literal("rejected"),
          Type.Literal("revise"),
        ]),
        feedback: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "control.question.asked",
    Type.Object(
      {
        questionId: QuestionIdSchema,
        kind: Type.Union([Type.Literal("next_run"), Type.Literal("generic")]),
        prompt: Type.String({ minLength: 1, maxLength: 2_000 }),
        choices: Type.Array(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: 64 }),
              label: Type.String({ minLength: 1, maxLength: 200 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 8 },
        ),
        planId: Type.Optional(PlanIdSchema),
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
        completedRunId: Type.Optional(RunIdSchema),
        nextPlanItemId: Type.Optional(PlanItemIdSchema),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "control.question.answered",
    Type.Object(
      {
        questionId: QuestionIdSchema,
        choiceId: Type.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "control.question.cancelled",
    Type.Object(
      {
        questionId: QuestionIdSchema,
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "run.triggered",
    Type.Object(
      {
        runId: RunIdSchema,
        trigger: Type.Union([
          Type.Literal("user"),
          Type.Literal("timer"),
          Type.Literal("event"),
          Type.Literal("resume"),
        ]),
        input: Type.Optional(Type.String({ maxLength: 100_000 })),
        mode: Type.Optional(SessionModeSchema),
        planBinding: Type.Optional(PlanBindingSchema),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "safety.redaction.applied",
    Type.Object(
      {
        boundary: Type.Union([
          Type.Literal("model-input"),
          Type.Literal("model-output"),
          Type.Literal("tool-output"),
          Type.Literal("context-compact"),
          Type.Literal("event-store"),
        ]),
        sourceEventType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        runId: Type.Optional(RunIdSchema),
        stepId: Type.Optional(StepIdSchema),
        actionId: Type.Optional(ActionIdSchema),
        redactions: Type.Array(
          Type.Object(
            {
              kind: Type.Union([
                Type.Literal("credential-assignment"),
                Type.Literal("authorization"),
                Type.Literal("provider-token"),
                Type.Literal("private-key"),
                Type.Literal("url-credential"),
              ]),
              count: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 16 },
        ),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "goal.created",
    Type.Object(
      {
        goalId: GoalIdSchema,
        contractVersion: Type.Integer({ minimum: 1 }),
        objective: Type.String({ minLength: 1, maxLength: 20_000 }),
        assertions: Type.Array(
          Type.Object(
            {
              assertionId: Type.String({ minLength: 1, maxLength: 200 }),
              description: Type.String({ minLength: 1, maxLength: 2_000 }),
              required: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        evidenceRequirements: Type.Array(
          Type.Object(
            {
              assertionId: Type.String({ minLength: 1, maxLength: 200 }),
              kinds: Type.Array(
                Type.Union([
                  Type.Literal("deterministic"),
                  Type.Literal("behavioral"),
                  Type.Literal("semantic"),
                  Type.Literal("human"),
                ]),
                { minItems: 1, uniqueItems: true },
              ),
              minimum: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
        boundaries: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true }),
        resources: Type.Array(
          Type.Object(
            {
              resource: ResourceNameSchema,
              limit: Type.Number({ exclusiveMinimum: 0 }),
              unit: Type.String({ minLength: 1, maxLength: 50 }),
            },
            { additionalProperties: false },
          ),
          { uniqueItems: true },
        ),
        stagnation: Type.Object(
          {
            windowSteps: Type.Integer({ minimum: 1 }),
            maxEquivalentFailures: Type.Integer({ minimum: 1 }),
            onTrip: Type.Union([
              Type.Literal("change-strategy"),
              Type.Literal("narrow-scope"),
              Type.Literal("park"),
            ]),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "goal.state.changed",
    Type.Object(
      {
        goalId: GoalIdSchema,
        state: GoalStateSchema,
        reason: Type.String({ minLength: 1, maxLength: 2_000 }),
        evaluationIds: Type.Optional(Type.Array(EvaluationIdSchema, { uniqueItems: true })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "goal.resource.consumed",
    Type.Object(
      {
        goalId: GoalIdSchema,
        runId: Type.Optional(RunIdSchema),
        resource: ResourceNameSchema,
        amount: Type.Number({ exclusiveMinimum: 0 }),
        reason: Type.String({ minLength: 1, maxLength: 1_000 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "goal.convergence.entered",
    Type.Object(
      { goalId: GoalIdSchema, resource: ResourceNameSchema, consumedRatio: Type.Number({ minimum: 0.75 }) },
      { additionalProperties: false },
    ),
  ),
  event(
    "goal.failure.recorded",
    Type.Object(
      {
        goalId: GoalIdSchema,
        runId: RunIdSchema,
        stepId: StepIdSchema,
        assertionId: Type.String({ minLength: 1, maxLength: 200 }),
        failureFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        progress: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "goal.stagnation.detected",
    Type.Object(
      {
        goalId: GoalIdSchema,
        runId: RunIdSchema,
        failureFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        equivalentFailures: Type.Integer({ minimum: 1 }),
        decision: Type.Union([
          Type.Literal("change-strategy"),
          Type.Literal("narrow-scope"),
          Type.Literal("park"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "evidence.recorded",
    Type.Object(
      {
        evidenceId: EvidenceIdSchema,
        goalId: GoalIdSchema,
        runId: Type.Optional(RunIdSchema),
        assertionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        kind: Type.Union([
          Type.Literal("deterministic"),
          Type.Literal("behavioral"),
          Type.Literal("semantic"),
          Type.Literal("human"),
        ]),
        artifactRef: Type.String({ minLength: 1, maxLength: 500 }),
        description: Type.String({ minLength: 1, maxLength: 2_000 }),
        producer: Type.String({ minLength: 1, maxLength: 200 }),
        reproducible: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "control.receipt.issued",
    Type.Object(
      {
        receiptId: ReceiptIdSchema,
        goalId: GoalIdSchema,
        phase: Type.Union([Type.Literal("granted"), Type.Literal("settled")]),
        issuedTo: Type.String({ minLength: 1, maxLength: 128 }),
        startRight: Type.Union([Type.Literal("user"), Type.Literal("schedule"), Type.Literal("event"), Type.Literal("agent")]),
        stopRight: Type.Union([Type.Literal("user"), Type.Literal("contract"), Type.Literal("agent")]),
        acceptanceRight: Type.Union([Type.Literal("human"), Type.Literal("evaluator"), Type.Literal("agent")]),
        delegationRight: Type.Boolean(),
        actionLeaseIds: Type.Array(LeaseIdSchema, { uniqueItems: true }),
        boundaries: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true }),
        resources: Type.Array(
          Type.Object(
            {
              resource: ResourceNameSchema,
              limit: Type.Number({ exclusiveMinimum: 0 }),
              consumed: Type.Number({ minimum: 0 }),
              unit: Type.String({ minLength: 1, maxLength: 50 }),
            },
            { additionalProperties: false },
          ),
        ),
        outcome: Type.Optional(GoalStateSchema),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "memory.candidate.created",
    Type.Object(
      {
        memoryId: MemoryIdSchema,
        layer: Type.Union([
          Type.Literal("working"),
          Type.Literal("episodic"),
          Type.Literal("semantic"),
          Type.Literal("procedural"),
          Type.Literal("relational"),
        ]),
        statement: Type.String({ minLength: 1, maxLength: 20_000 }),
        scope: Type.String({ minLength: 1, maxLength: 500 }),
        provenance: Type.Array(Type.Object(
          { sessionId: SessionIdSchema, eventId: EventIdSchema, sequence: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ), { minItems: 1 }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        sensitivity: Type.Union([Type.Literal("public"), Type.Literal("private"), Type.Literal("secret")]),
        validFrom: Type.String({ pattern: isoTimestampPattern }),
        expiresAt: Type.Optional(Type.String({ pattern: isoTimestampPattern })),
        contradictionOf: Type.Optional(MemoryIdSchema),
        requiresConfirmation: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "memory.accepted",
    Type.Object(
      { memoryId: MemoryIdSchema, confirmedBy: Type.String({ minLength: 1, maxLength: 128 }) },
      { additionalProperties: false },
    ),
  ),
  event(
    "memory.disputed",
    Type.Object(
      { memoryId: MemoryIdSchema, reason: Type.String({ minLength: 1, maxLength: 2_000 }), correctionMemoryId: Type.Optional(MemoryIdSchema) },
      { additionalProperties: false },
    ),
  ),
  event(
    "memory.forgotten",
    Type.Object(
      { memoryId: MemoryIdSchema, reason: Type.String({ minLength: 1, maxLength: 2_000 }) },
      { additionalProperties: false },
    ),
  ),
  event(
    "attention.policy.set",
    Type.Object(
      {
        timezone: Type.String({ minLength: 1, maxLength: 100 }),
        quietStart: Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
        quietEnd: Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
        maxInterruptions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "attention.interruption.recorded",
    Type.Object(
      { goalId: Type.Optional(GoalIdSchema), reason: Type.String({ minLength: 1, maxLength: 2_000 }) },
      { additionalProperties: false },
    ),
  ),
  event(
    "presence.changed",
    Type.Object(
      {
        state: Type.Union([
          Type.Literal("active"),
          Type.Literal("waiting"),
          Type.Literal("watching"),
          Type.Literal("sleeping"),
          Type.Literal("blocked"),
        ]),
        reason: Type.String({ minLength: 1, maxLength: 2_000 }),
        wakeAt: Type.Optional(Type.String({ pattern: isoTimestampPattern })),
      },
      { additionalProperties: false },
    ),
  ),
  event("run.started", RunRef),
  event(
    "graph.node.entered",
    Type.Object(
      {
        runId: RunIdSchema,
        graphId: Type.String({ minLength: 1, maxLength: 128 }),
        graphVersion: Type.Integer({ minimum: 1 }),
        nodeId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "graph.transitioned",
    Type.Object(
      {
        runId: RunIdSchema,
        graphId: Type.String({ minLength: 1, maxLength: 128 }),
        graphVersion: Type.Integer({ minimum: 1 }),
        edgeId: Type.String({ minLength: 1, maxLength: 128 }),
        from: Type.String({ minLength: 1, maxLength: 128 }),
        to: Type.String({ minLength: 1, maxLength: 128 }),
        decision: Type.Union([Type.Literal("deterministic"), Type.Literal("model")]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "graph.definition.updated",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        graphId: Type.String({ minLength: 1, maxLength: 128 }),
        fromVersion: Type.Integer({ minimum: 1 }),
        toVersion: Type.Integer({ minimum: 2 }),
        definitionRef: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "delegation.created",
    Type.Object(
      {
        runId: RunIdSchema,
        delegationId: Type.String({ pattern: "^dlg_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" }),
        childSessionId: SessionIdSchema,
        outcome: Type.String({ minLength: 1, maxLength: 2_000 }),
        returnPolicy: Type.Union([Type.Literal("result"), Type.Literal("result+trace"), Type.Literal("evidence-only")]),
        depth: Type.Literal(1),
        receiptId: Type.String({ minLength: 1, maxLength: 200 }),
        parentLeaseId: Type.String({ minLength: 1, maxLength: 200 }),
        childLeaseId: Type.String({ minLength: 1, maxLength: 200 }),
        childSubject: Type.String({ minLength: 1, maxLength: 200 }),
        contextRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { uniqueItems: true, maxItems: 32 }),
        contractRef: Type.String({ minLength: 1, maxLength: 500 }),
        resourceEnvelope: Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Number({ exclusiveMinimum: 0 })),
        workspaceBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "delegation.returned",
    Type.Object(
      {
        runId: RunIdSchema,
        delegationId: Type.String({ pattern: "^dlg_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" }),
        childSessionId: SessionIdSchema,
        outcome: Type.Union([
          Type.Literal("accepted"),
          Type.Literal("rejected"),
          Type.Literal("cancelled"),
          Type.Literal("timed_out"),
          Type.Literal("failed"),
        ]),
        resultRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        summaryRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { uniqueItems: true }),
        coordinationWallTimeMs: Type.Integer({ minimum: 0 }),
        reasons: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "steering.received",
    Type.Object(
      {
        runId: RunIdSchema,
        message: Type.String({ minLength: 1, maxLength: 100_000 }),
      },
      { additionalProperties: false },
    ),
  ),
  event("step.started", StepRef),
  event(
    "context.compacted",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        sourceStepId: StepIdSchema,
        artifactRef: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
        originalEstimatedTokens: Type.Integer({ minimum: 1 }),
        compactedEstimatedTokens: Type.Integer({ minimum: 1 }),
        messageCount: Type.Integer({ minimum: 1 }),
        reason: Type.Union([Type.Literal("pressure"), Type.Literal("hard-limit")]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "context.compiled",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        includedBlockIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
        omittedBlockIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
        estimatedTokens: Type.Integer({ minimum: 0 }),
        budgetTokens: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "model.completed",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        requestId: Type.String({ minLength: 1, maxLength: 200 }),
        provider: Type.String({ minLength: 1, maxLength: 100 }),
        model: Type.String({ minLength: 1, maxLength: 200 }),
        finishReason: Type.Union([
          Type.Literal("stop"),
          Type.Literal("actions"),
          Type.Literal("length"),
        ]),
        text: Type.String(),
        reasoning: Type.Optional(Type.String()),
        actionCalls: Type.Array(
          Type.Object(
            {
              callId: Type.String({ minLength: 1, maxLength: 200 }),
              name: Type.String({ minLength: 1, maxLength: 128 }),
              input: Type.Unknown(),
            },
            { additionalProperties: false },
          ),
        ),
        usage: Type.Optional(
          Type.Object(
            {
              inputTokens: Type.Integer({ minimum: 0 }),
              outputTokens: Type.Integer({ minimum: 0 }),
              cachedInputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "step.completed",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        finishReason: Type.Union([
          Type.Literal("action-requested"),
          Type.Literal("response"),
          Type.Literal("handoff"),
          Type.Literal("error"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "model.action.rejected",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        callId: Type.String({ minLength: 1, maxLength: 200 }),
        toolName: Type.String({ minLength: 1, maxLength: 128 }),
        errorCode: Type.Union([Type.Literal("TOOL_INPUT"), Type.Literal("ACTION_BATCH_LIMIT")]),
        reason: Type.String({ minLength: 1, maxLength: 1_000 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "action.proposed",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        toolName: Type.String({ minLength: 1, maxLength: 128 }),
        toolIdentity: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        input: Type.Optional(Type.Unknown()),
        resources: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { uniqueItems: true })),
        effect: Type.Union([
          Type.Literal("read"),
          Type.Literal("write"),
          Type.Literal("execute"),
          Type.Literal("publish"),
          Type.Literal("spend"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "action.freshness.rebased",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        priorActionId: ActionIdSchema,
        resource: Type.String({ minLength: 1, maxLength: 1_000 }),
        originalExpectedSha256: Type.String({ pattern: sha256Pattern }),
        effectiveExpectedSha256: Type.String({ pattern: sha256Pattern }),
      },
      { additionalProperties: false },
    ),
  ),
  event("authority.requested", ActionRef),
  event(
    "authority.granted",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        leaseId: LeaseIdSchema,
        policyTrace: Type.Optional(Type.Array(Type.Object(
          { leaseId: LeaseIdSchema, matched: Type.Boolean(), reason: Type.String({ minLength: 1, maxLength: 1_000 }) },
          { additionalProperties: false },
        ))),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "authority.denied",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        reason: Type.String({ minLength: 1 }),
        policyTrace: Type.Optional(Type.Array(Type.Object(
          { leaseId: LeaseIdSchema, matched: Type.Boolean(), reason: Type.String({ minLength: 1, maxLength: 1_000 }) },
          { additionalProperties: false },
        ))),
      },
      { additionalProperties: false },
    ),
  ),
  event("action.started", ActionRef),
  event(
    "task.started",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        taskId: TaskIdSchema,
        command: Type.String({ minLength: 1, maxLength: 2_048 }),
        args: Type.Array(Type.String({ maxLength: 16_384 }), { maxItems: 200 }),
        workdir: Type.String({ minLength: 1, maxLength: 2_048 }),
        pid: Type.Integer({ minimum: 1 }),
        expiresAt: Type.String({ pattern: isoTimestampPattern }),
        logRef: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "task.stop.requested",
    Type.Object(
      { taskId: TaskIdSchema, reason: Type.String({ minLength: 1, maxLength: 2_000 }) },
      { additionalProperties: false },
    ),
  ),
  event(
    "task.exited",
    Type.Object(
      {
        taskId: TaskIdSchema,
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        reason: Type.Union([Type.Literal("exited"), Type.Literal("stopped"), Type.Literal("expired")]),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "task.lost",
    Type.Object(
      { taskId: TaskIdSchema, reason: Type.String({ minLength: 1, maxLength: 2_000 }) },
      { additionalProperties: false },
    ),
  ),
  event(
    "action.completed",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        outputRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        modelOutput: Type.Optional(Type.Array(Type.Unknown())),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "action.failed",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        errorCode: Type.String({ minLength: 1, maxLength: 128 }),
        evidenceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        modelOutput: Type.Optional(Type.Array(Type.Unknown())),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "action.cancelled",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        reason: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "action.indeterminate",
    Type.Object(
      {
        runId: RunIdSchema,
        stepId: StepIdSchema,
        actionId: ActionIdSchema,
        reason: Type.String({ minLength: 1 }),
        reconciliationHint: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "evaluation.completed",
    Type.Object(
      {
        runId: RunIdSchema,
        goalId: Type.Optional(GoalIdSchema),
        evaluationId: EvaluationIdSchema,
        assertionId: Type.String({ minLength: 1, maxLength: 200 }),
        evaluatorKind: Type.Union([
          Type.Literal("deterministic"),
          Type.Literal("semantic"),
          Type.Literal("human"),
        ]),
        evaluatorVersion: Type.String({ minLength: 1, maxLength: 200 }),
        calibration: Type.Union([
          Type.Literal("trusted"),
          Type.Literal("untrusted"),
          Type.Literal("not-required"),
        ]),
        outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
        reportedOutcome: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")])),
        evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { uniqueItems: true }),
        reproducible: Type.Optional(Type.Boolean()),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "run.parked",
    Type.Object(
      {
        runId: RunIdSchema,
        reason: Type.Union([
          Type.Literal("waiting-input"),
          Type.Literal("authority-denied"),
          Type.Literal("indeterminate-effect"),
          Type.Literal("stagnation"),
          Type.Literal("budget"),
          Type.Literal("review"),
        ]),
        detail: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "run.completed",
    Type.Object(
      {
        runId: RunIdSchema,
        completionKind: Type.Union([Type.Literal("response"), Type.Literal("verified")]),
        evaluationIds: Type.Array(EvaluationIdSchema, { uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "run.failed",
    Type.Object(
      {
        runId: RunIdSchema,
        code: Type.String({ minLength: 1, maxLength: 128 }),
        diagnosticRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "run.cancelled",
    Type.Object(
      { runId: RunIdSchema, reason: Type.String({ minLength: 1, maxLength: 2_000 }) },
      { additionalProperties: false },
    ),
  ),
]);

export type SessionEvent = Static<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent["type"];

export function parseSessionEvent(value: unknown): SessionEvent {
  if (Value.Check(SessionEventSchema, value)) {
    return value;
  }

  const details = [...Value.Errors(SessionEventSchema, value)]
    .slice(0, 8)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new TypeError(`SessionEvent is invalid: ${details}`);
}
