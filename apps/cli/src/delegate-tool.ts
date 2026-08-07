import {
  Coordinator,
  DELEGATED_SUMMARY_PREVIEW_CHARS,
  runDelegatedBatch,
  runDelegatedTurn,
} from "@civaapple/qi-agent/extensions";
import { GoalEngine } from "@civaapple/qi-agent/eval";
import type { EventStore } from "@civaapple/qi-agent/kernel";
import type { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import type { ModelRef } from "@civaapple/qi-ai";
import type { TurnLoop } from "@civaapple/qi-agent/loop";
import type { SessionEvent } from "@civaapple/qi-protocol";
import { ToolFailure, defineTool, type ArtifactStore, type ToolRegistry } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";
import {
  DEFAULT_DELEGATE_WALL_TIME_MS,
  DELEGATE_WALL_TIME_MS_MAX,
} from "./config.js";
import { buildDelegatedTaskBrief, delegatedTaskTitle } from "./delegated-task-brief.js";

const ArtifactRefSchema = Type.String({ pattern: "^artifact://[a-f0-9]{64}$" });
const BriefLineSchema = Type.String({ minLength: 1, maxLength: 500 });

const TaskItemSchema = Type.Object(
  {
    objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    /** Cursor-style Focus bullets; Qi fills research defaults when omitted. */
    focus: Type.Optional(Type.Array(BriefLineSchema, { minItems: 1, maxItems: 12 })),
    /** Cursor-style Return bullets; Qi fills research defaults when omitted. */
    returns: Type.Optional(Type.Array(BriefLineSchema, { minItems: 1, maxItems: 12 })),
    /** Extra Constraints; merged with built-in read-only research rules. */
    constraints: Type.Optional(Type.Array(BriefLineSchema, { minItems: 1, maxItems: 8 })),
    context: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    contextRefs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 8, uniqueItems: true })),
  },
  { additionalProperties: false },
);

const DelegateInputSchema = Type.Object(
  {
    objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
    focus: Type.Optional(Type.Array(BriefLineSchema, { minItems: 1, maxItems: 12 })),
    returns: Type.Optional(Type.Array(BriefLineSchema, { minItems: 1, maxItems: 12 })),
    constraints: Type.Optional(Type.Array(BriefLineSchema, { minItems: 1, maxItems: 8 })),
    context: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    contextRefs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 8, uniqueItems: true })),
    /** Parallel Plan research fan-out (1–4). Mutually exclusive with top-level objective. */
    tasks: Type.Optional(Type.Array(TaskItemSchema, { minItems: 1, maxItems: 4 })),
    maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    contextTokens: Type.Optional(Type.Integer({ minimum: 512, maximum: 200_000 })),
    wallTimeMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: DELEGATE_WALL_TIME_MS_MAX })),
  },
  { additionalProperties: false },
);

type DelegateInput = Static<typeof DelegateInputSchema>;
type TaskItem = Static<typeof TaskItemSchema>;

const DelegationOutcomeSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("rejected"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("failed"),
]);

const DelegationResultSchema = Type.Object(
  {
    accepted: Type.Boolean(),
    outcome: DelegationOutcomeSchema,
    delegationId: Type.String(),
    childSessionId: Type.String(),
    summary: Type.String(),
    summaryRef: Type.Optional(Type.String()),
    resultRef: Type.Optional(Type.String()),
    reasons: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export interface DelegateBudgetDefaults {
  contextTokens: number;
  maxSteps: number;
  wallTimeMs: number;
  maxUses: number;
  maxActionsPerStep?: number;
}

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
  childResources: readonly string[];
  /** Defaults derived from parent context window / max-steps (ADR-0035). */
  budgetDefaults: DelegateBudgetDefaults | (() => DelegateBudgetDefaults);
  /** Forward parent `delegation.*` facts so TUI/Web see Tasks while the Action is still running. */
  onEvent?: (event: SessionEvent) => void;
}

/** Opt-in parent tool that runs depth-1 context-isolated Subagent(s) and returns summary/refs only. */
export function createDelegateTool(deps: DelegateToolDeps) {
  return defineTool({
    description:
      "Delegate bounded research to depth-1 isolated Subagent(s). Prefer Cursor-style briefs: short objective plus " +
      "optional focus[] / returns[] / constraints[]; Qi always expands these into a Focus/Return/Constraints child " +
      "prompt (defaults fill gaps). Pass allowlisted context or contextRefs, or tasks[] (1–4) for parallel fan-out. " +
      "Default child envelope is half the parent maxSteps/contextTokens with a 5-minute wall " +
      "(override via maxSteps/wallTimeMs/contextTokens or user [delegate]; wall hard-capped at 30m). " +
      "Size each task to fit that envelope: one document surface or theme per child — split large comparisons " +
      "across tasks[] instead of one exhaustive crawl. The child brief Constraints include the actual budget. " +
      "Children cannot delegate. You receive a short summary preview plus summaryRef/resultRef — never child " +
      "transcripts. Full deliverable text is in resultRef: call artifact_get(resultRef) or pass resultRef as " +
      "contextRefs. Never workspace-read artifact:// with read. Do not fan out extract/补齐 Subagents only " +
      "because the inline summary is short. If outcome is timed_out: keep using each child's partial " +
      "summary/resultRef; fill only missing gaps yourself (do not restart the whole fan-out unless evidence is " +
      "empty). cancelled means user/parent interrupt; failed/rejected need a revised contract or solo work. " +
      "After research, synthesize into plan_document.",
    input: DelegateInputSchema,
    output: Type.Object(
      {
        accepted: Type.Boolean(),
        results: Type.Array(DelegationResultSchema, { minItems: 1, maxItems: 4 }),
        /** Present when a single objective was used (not tasks[]). */
        delegationId: Type.Optional(Type.String()),
        childSessionId: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        summaryRef: Type.Optional(Type.String()),
        resultRef: Type.Optional(Type.String()),
        reasons: Type.Array(Type.String()),
        /** Parent-facing recovery hint when any child timed out or failed. */
        parentHint: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    effect: () => "read",
    resources: () => ["delegation:local"],
    execute: async (input: DelegateInput, context) => {
      const taskItems = normalizeTasks(input);
      const budget = resolveBudget(deps.budgetDefaults, input);
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
        ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
      });
      const runnerOptions = {
        coordinator,
        turnLoop: deps.turnLoop,
        model: typeof deps.model === "function" ? deps.model() : deps.model,
        workspaceRoot: deps.workspaceRoot,
        artifactStore: deps.artifactStore,
        toolRegistry: deps.toolRegistry,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      };

      const briefBudget = {
        maxSteps: budget.maxSteps,
        wallTimeMs: budget.wallTimeMs,
        contextTokens: budget.contextTokens,
      };

      if (taskItems.length === 1) {
        const item = taskItems[0]!;
        const contextRefs = await resolveContextRefs(deps.artifactStore, item);
        const brief = buildDelegatedTaskBrief({ ...item, budget: briefBudget });
        const result = await runDelegatedTurn(
          buildContract(item.objective, contextRefs, deps, budget),
          authorization,
          { ...runnerOptions, input: brief },
        );
        const mapped = await mapResult(deps.artifactStore, result);
        const parentHint = parentHintForResults([mapped]);
        return {
          accepted: mapped.accepted,
          results: [mapped],
          delegationId: mapped.delegationId,
          childSessionId: mapped.childSessionId,
          summary: mapped.summary,
          ...(mapped.summaryRef === undefined ? {} : { summaryRef: mapped.summaryRef }),
          ...(mapped.resultRef === undefined ? {} : { resultRef: mapped.resultRef }),
          reasons: mapped.reasons,
          ...(parentHint === undefined ? {} : { parentHint }),
        };
      }

      const prepared = [];
      for (const item of taskItems) {
        const contextRefs = await resolveContextRefs(deps.artifactStore, item);
        prepared.push({
          contract: buildContract(item.objective, contextRefs, deps, budget),
          input: buildDelegatedTaskBrief({ ...item, budget: briefBudget }),
        });
      }
      const batch = await runDelegatedBatch(prepared, authorization, runnerOptions);
      const results = [];
      for (const result of batch) results.push(await mapResult(deps.artifactStore, result));
      const parentHint = parentHintForResults(results);
      return {
        accepted: results.every((item) => item.accepted),
        results,
        reasons: results.flatMap((item) => item.reasons),
        ...(parentHint === undefined ? {} : { parentHint }),
      };
    },
  });
}

function normalizeTasks(input: DelegateInput): TaskItem[] {
  const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
  const hasObjective = typeof input.objective === "string" && input.objective.trim().length > 0;
  if (hasTasks && hasObjective) {
    throw new ToolFailure(
      "DELEGATION_INPUT_CONFLICT",
      "Provide either objective or tasks[], not both",
    );
  }
  if (hasTasks) return input.tasks!;
  if (hasObjective) {
    return [{
      objective: input.objective!,
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(input.returns === undefined ? {} : { returns: input.returns }),
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
    }];
  }
  throw new ToolFailure("DELEGATION_OBJECTIVE_REQUIRED", "Provide objective or tasks[]");
}

function resolveBudget(
  defaults: DelegateBudgetDefaults | (() => DelegateBudgetDefaults),
  input: DelegateInput,
): DelegateBudgetDefaults {
  const base = typeof defaults === "function" ? defaults() : defaults;
  return {
    contextTokens: input.contextTokens ?? base.contextTokens,
    maxSteps: input.maxSteps ?? base.maxSteps,
    wallTimeMs: input.wallTimeMs ?? base.wallTimeMs,
    maxUses: base.maxUses,
    ...(base.maxActionsPerStep === undefined ? {} : { maxActionsPerStep: base.maxActionsPerStep }),
  };
}

async function resolveContextRefs(
  artifactStore: ArtifactStore,
  item: TaskItem,
): Promise<string[]> {
  const contextRefs = [...(item.contextRefs ?? [])];
  if (item.context) {
    const stored = await artifactStore.put(Buffer.from(item.context, "utf8"), "text/plain; charset=utf-8");
    contextRefs.push(stored.ref);
  }
  if (contextRefs.length === 0) {
    throw new ToolFailure(
      "DELEGATION_CONTEXT_REQUIRED",
      "Provide context and/or contextRefs so the child does not inherit the parent transcript",
    );
  }
  return contextRefs;
}

function buildContract(
  objective: string,
  contextRefs: readonly string[],
  deps: DelegateToolDeps,
  budget: DelegateBudgetDefaults,
) {
  return {
    outcome: delegatedTaskTitle(objective, 160),
    deliverableSchema: Type.Object({
      summary: Type.String(),
      status: Type.String(),
    }, { additionalProperties: false }),
    contextRefs: [...contextRefs],
    parentLeaseId: deps.parentLeaseId,
    childLease: {
      tools: [...deps.childTools],
      effects: ["read" as const],
      resources: [...deps.childResources],
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      maxUses: budget.maxUses,
    },
    resourceEnvelope: {
      contextTokens: budget.contextTokens,
      maxSteps: budget.maxSteps,
      wallTimeMs: budget.wallTimeMs,
      ...(budget.maxActionsPerStep === undefined ? {} : { maxActionsPerStep: budget.maxActionsPerStep }),
    },
    evidenceRequired: [] as const,
    returnPolicy: "result" as const,
  };
}

async function mapResult(
  artifactStore: ArtifactStore,
  result: Awaited<ReturnType<typeof runDelegatedTurn>>,
) {
  let summary = result.turn.text.trim().slice(0, DELEGATED_SUMMARY_PREVIEW_CHARS);
  if (result.summaryRef) {
    try {
      const stored = await artifactStore.get(result.summaryRef);
      summary = Buffer.from(stored.content).toString("utf8");
    } catch {
      // keep turn text
    }
  }
  return {
    accepted: result.settlement.accepted,
    outcome: result.settlement.outcome,
    delegationId: result.handle.delegationId,
    childSessionId: result.handle.childSessionId,
    summary,
    ...(result.summaryRef === undefined ? {} : { summaryRef: result.summaryRef }),
    ...(result.resultRef === undefined ? {} : { resultRef: result.resultRef }),
    reasons: result.settlement.reasons,
  };
}

function parentHintForResults(
  results: readonly { outcome: string; summary: string; resultRef?: string }[],
): string | undefined {
  const parts: string[] = [];
  const timedOut = results.filter((item) => item.outcome === "timed_out");
  if (timedOut.length > 0) {
    const withPartial = timedOut.filter((item) => item.summary.trim().length > 0).length;
    parts.push(
      `${timedOut.length} Subagent(s) timed out (wall-time limit). ` +
        `Use the ${withPartial} partial summary/resultRef value(s) already returned; ` +
        "only fetch missing facts yourself. Do not re-delegate the same batch unless summaries are empty.",
    );
  }
  if (results.some((item) => item.resultRef)) {
    parts.push(
      "Full child deliverable text is at each resultRef (summary/summaryRef are short previews). " +
        "Use artifact_get(resultRef) or pass resultRef via contextRefs; never read(artifact://…). " +
        "Do not fan out extract/补齐 Subagents only because the inline summary is short.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
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

/** Derive child envelope defaults from parent Run budgets (ADR-0035). */
export function childDelegateBudgetDefaults(
  parent: {
    contextBudgetTokens: number;
    maxSteps: number;
    maxActionsPerStep: number;
  },
  options?: {
    wallTimeMs?: number;
    maxStepsPercent?: number;
    contextTokensPercent?: number;
  },
): DelegateBudgetDefaults {
  const maxStepsPercent = options?.maxStepsPercent ?? 50;
  const contextTokensPercent = options?.contextTokensPercent ?? 50;
  const wallTimeMs = options?.wallTimeMs ?? DEFAULT_DELEGATE_WALL_TIME_MS;
  const maxSteps = Math.max(1, Math.floor(parent.maxSteps * (maxStepsPercent / 100)));
  return {
    contextTokens: Math.max(512, Math.floor(parent.contextBudgetTokens * (contextTokensPercent / 100))),
    maxSteps,
    wallTimeMs,
    maxUses: Math.max(1, maxSteps * parent.maxActionsPerStep),
    maxActionsPerStep: parent.maxActionsPerStep,
  };
}
