import { createHash, randomUUID } from "node:crypto";
import {
  mergeRedactionSummaries,
  modeAllowsIntent,
  redactSensitiveText,
  redactSensitiveValue,
  type Effect,
  type RedactionSummary,
} from "@civaapple/qi-agent/capability";
import {
  ContextBudgetError,
  approximateTokenEstimator,
  compileContext,
  estimateSerializedTokens,
  type ContextBlock,
  type TokenEstimator,
} from "@civaapple/qi-ai/context";
import { GoalEngine } from "@civaapple/qi-agent/eval";
import {
  StateTransitionError,
  type EventStore,
  type RunGoalBinding,
  type RunPlanBinding,
  type RunView,
  type SessionMode,
  type SessionView,
} from "@civaapple/qi-agent/kernel";
import type { ModelContentPart, ModelEvent, ModelMessage, ModelPort, ModelRef } from "@civaapple/qi-ai";
import {
  createId,
  type GoalId,
  type RunId,
  type RunInputPart,
  type SessionEvent,
  type SessionId,
  type StepId,
} from "@civaapple/qi-protocol";
import {
  AuthorityDeniedError,
  ToolFailure,
  ToolInputError,
  type ArtifactStore,
  type InspectedToolCall,
  type ToolExecutionContext,
  type ToolRegistry,
} from "@civaapple/qi-agent/tools";
import type { EffectJournal } from "@civaapple/qi-agent/effects";
import { EventWriter } from "./event-writer.js";
import { createGoalContextBlock } from "./goal-continuation.js";
import { formatIndeterminateParkDetail } from "./indeterminate-detail.js";
import type { RuntimeActivity } from "./runtime-activity.js";
import { isToolAllowedInMode, toolsForMode } from "./session-mode.js";
import { SteeringMailbox } from "./steering.js";

export interface TurnLoopOptions {
  eventStore: EventStore;
  modelPort: ModelPort;
  toolRegistry: ToolRegistry;
  clock?: () => Date;
  steeringMailbox?: SteeringMailbox;
  onEvent?: (event: SessionEvent) => void;
  onActivity?: (activity: RuntimeActivity) => void;
}

export interface TurnRequest {
  sessionId: SessionId;
  title?: string;
  subject: string;
  input: string;
  /** Ordered durable human input. Omit for the legacy text-only path. */
  content?: readonly RunInputPart[];
  model: ModelRef;
  contextBlocks: readonly ContextBlock[];
  contextBudgetTokens: number;
  /** Use one deterministic estimator for ContextBlocks, messages, and Tool schemas. */
  tokenEstimator?: TokenEstimator;
  maxOutputTokens?: number;
  historyBudgetTokens?: number;
  maxSteps: number;
  /**
   * Reserve the final Step for a tool-free budget handoff. Execution surfaces
   * should enable this; embedded callers retain the historical maxSteps contract.
   */
  reserveFinalHandoff?: boolean;
  maxActionsPerStep?: number;
  /** When set, only these tool names are advertised to the model for this Turn. */
  toolAllowlist?: readonly string[];
  /** A drafting Run may not complete until a matching Action has successfully committed its document. */
  requiredCompletionTool?: {
    toolName: string;
    /** Optional effect constraint; applications should set this when reads cannot satisfy completion. */
    effect?: Effect;
    correction: string;
    parkReason: "review";
  };
  /** Session mode frozen onto run.triggered when creating a new Run. */
  mode?: SessionMode;
  planBinding?: RunPlanBinding;
  /** Optional Session-local Goal binding for 追寻 Runs. */
  goalBinding?: RunGoalBinding;
  /**
   * How this Run was started. Defaults to `user` for new Runs and `goal` when
   * `goalBinding` is set without an explicit trigger.
   */
  trigger?: "user" | "goal" | "timer" | "event" | "resume";
  /** Execute a Run that was already durably triggered (Plan accept / next-run answer). */
  existingRunId?: RunId;
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  effectJournal?: EffectJournal;
  signal?: AbortSignal;
  /** Live read-only mounts; called when building each Action context. */
  getMounts?: () => readonly import("@civaapple/qi-agent/tools").WorkspaceMount[];
  /** Live sensitive-path grants; called when building each Action context. */
  getSensitivePathGrants?: () => readonly string[];
  /** Optional project overlays for sensitive-path classification. */
  sensitivePathPolicy?: {
    readonly extra?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

export interface TurnResult {
  sessionId: SessionId;
  runId: RunId;
  status: "completed" | "parked" | "failed" | "cancelled";
  text: string;
  view: SessionView;
}

interface AggregatedModelResult {
  text: string;
  reasoning: string;
  actions: Array<{ callId: string; name: string; input: unknown }>;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  terminal:
    | { type: "completed"; finishReason: "stop" | "actions" | "length"; responseId?: string }
    | { type: "failed"; code: string; message: string; retryable: boolean };
}

interface CandidateCall {
  callId: string;
  actionId: string;
  inspected: InspectedToolCall;
  context: ToolExecutionContext;
}

interface SuccessfulStepWrite {
  actionId: string;
  toolName: string;
  editChain?: {
    originalSha256: string;
    latestSha256: string;
  };
}

interface StepMutationAttempt {
  actionId: string;
  toolName: string;
  status: "completed" | "failed" | "denied";
}

/**
 * Same-Step BATCH_WRITE_CONFLICT only applies to content-bearing mutation resources.
 * Host execute resources (`host-process:*`, `host-workspace:*`, `shell-profile:*`, …) are excluded so
 * sequential shells/scripts in one Step can share a workdir without a false conflict; file/artifact
 * freshness rules stay fail-closed.
 */
export function isBatchWriteConflictResource(resource: string): boolean {
  return resource.startsWith("file:") || resource.startsWith("artifact-store:");
}

function conflictResources(resources: readonly string[]): string[] {
  return resources.filter((resource) => isBatchWriteConflictResource(resource));
}

interface RejectedModelCall {
  callId: string;
  toolName: string;
  errorCode: "TOOL_INPUT" | "ACTION_BATCH_LIMIT";
  reason: string;
}

type ToolResultPart = Extract<ModelContentPart, { type: "tool-result" }>;

interface SettledActionExchange {
  sourceStepId: StepId;
  messages: ModelMessage[];
  consumed: boolean;
  compacted: boolean;
}

const contextPressureRatio = 0.75;
const contextPressureTargetRatio = 0.55;

class ContextCompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextCompactionError";
  }
}

export class TurnLoop {
  readonly #eventStore: EventStore;
  readonly #modelPort: ModelPort;
  readonly #toolRegistry: ToolRegistry;
  readonly #clock: () => Date;
  readonly #steeringMailbox: SteeringMailbox;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;
  readonly #onActivity: ((activity: RuntimeActivity) => void) | undefined;

  constructor(options: TurnLoopOptions) {
    this.#eventStore = options.eventStore;
    this.#modelPort = options.modelPort;
    this.#toolRegistry = options.toolRegistry;
    this.#clock = options.clock ?? (() => new Date());
    this.#steeringMailbox = options.steeringMailbox ?? new SteeringMailbox();
    this.#onEvent = options.onEvent;
    this.#onActivity = options.onActivity;
  }

  steer(sessionId: SessionId, message: string, actorId = "user"): void {
    this.#steeringMailbox.enqueue(sessionId, message, actorId);
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    if (!Number.isInteger(request.contextBudgetTokens) || request.contextBudgetTokens <= 0) {
      throw new RangeError("contextBudgetTokens must be a positive integer");
    }
    if (
      request.maxOutputTokens !== undefined &&
      (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
    ) {
      throw new RangeError("maxOutputTokens must be a positive integer when provided");
    }
    if (!Number.isInteger(request.maxSteps) || request.maxSteps <= 0) {
      throw new RangeError("maxSteps must be a positive integer");
    }
    const maxActionsPerStep = request.maxActionsPerStep ?? 8;
    if (!Number.isInteger(maxActionsPerStep) || maxActionsPerStep <= 0) {
      throw new RangeError("maxActionsPerStep must be a positive integer");
    }
    const requestedHistoryBudgetTokens = request.historyBudgetTokens
      ?? Math.min(16_000, Math.floor(request.contextBudgetTokens / 4));
    if (!Number.isInteger(requestedHistoryBudgetTokens) || requestedHistoryBudgetTokens < 0) {
      throw new RangeError("historyBudgetTokens must be a non-negative integer");
    }
    validateTurnContent(request.input, request.content);
    if (request.existingRunId === undefined) {
      await assertImageCapability(this.#modelPort, request.model, request.content);
    }
    const writer = new EventWriter(this.#eventStore, request.sessionId, this.#clock, this.#onEvent);
    if (!writer.view) {
      writer.append(
        "session.created",
        {
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.mode === undefined ? {} : { mode: request.mode }),
        },
        { kind: "runtime", id: "qi" },
      );
    }

    const sessionMode = writer.view?.mode ?? request.mode ?? "agent";
    const runMode = request.mode ?? sessionMode;
    let runId: RunId;
    let runInput = request.input;
    let runContent = request.content === undefined ? undefined : request.content.map((part) => ({ ...part }));
    if (request.existingRunId) {
      const existing = writer.view?.runs[request.existingRunId];
      if (!existing || existing.status !== "triggered") {
        throw new Error(`existingRunId ${request.existingRunId} is not in triggered status`);
      }
      runId = request.existingRunId;
      runInput = existing.input ?? request.input;
      runContent = existing.content ?? runContent;
      await assertImageCapability(this.#modelPort, request.model, runContent);
    } else {
      runId = createId("run") as RunId;
      const goalBinding = resolveGoalBinding(writer.view, request.goalBinding);
      const trigger = request.trigger
        ?? (goalBinding === undefined ? "user" : "goal");
      writer.append(
        "run.triggered",
        {
          runId,
          trigger,
          input: request.input,
          ...(runContent === undefined ? {} : { content: runContent }),
          mode: runMode,
          ...(request.planBinding === undefined ? {} : { planBinding: request.planBinding }),
          ...(goalBinding === undefined ? {} : { goalBinding }),
        },
        { kind: trigger === "user" ? "user" : "runtime", id: request.subject },
      );
    }
    writer.append("run.started", { runId }, { kind: "runtime", id: "qi" });
    const frozenMode = writer.view?.runs[runId]?.mode ?? runMode;
    const frozenGoalBinding = writer.view?.runs[runId]?.goalBinding;
    const goalEngine = frozenGoalBinding
      ? new GoalEngine(this.#eventStore, request.sessionId, {
          clock: this.#clock,
          ...(this.#onEvent === undefined ? {} : { onEvent: this.#onEvent }),
        })
      : undefined;

    const estimator = request.tokenEstimator ?? approximateTokenEstimator;
    const currentInputMessage: ModelMessage = {
      role: "user",
      content: toModelInputParts(runInput, runContent, false),
    };
    const registeredNames = this.#toolRegistry.catalog().map((tool) => tool.name);
    const initialModeTools = toolsForMode(frozenMode, registeredNames);
    const initialAllowlist = request.toolAllowlist
      ? initialModeTools.filter((name) => request.toolAllowlist!.includes(name))
      : initialModeTools;
    const initialCatalog = this.#toolRegistry.catalog({ tools: initialAllowlist });
    const initialToolCatalogTokens = estimateToolCatalog(initialCatalog.map((tool) => tool.model), estimator);
    const requiredBlockTokens = request.contextBlocks
      .filter((block) => block.required)
      .reduce((total, block) => total + estimator.estimate(block.content), 0);
    const dynamicControlReserve = request.reserveFinalHandoff === true
      ? Math.max(
          estimator.estimate(createBudgetWarningBlock(request.maxSteps - 1, request.maxSteps).content),
          estimator.estimate(createBudgetHandoffBlock(request.maxSteps, request.maxSteps).content),
        )
      : 0;
    const historyCapacity = Math.max(
      0,
      request.contextBudgetTokens
        - estimateMessages([currentInputMessage], estimator)
        - initialToolCatalogTokens
        - requiredBlockTokens
        - dynamicControlReserve,
    );
    const history = compileConversationHistory(
      writer.view,
      Math.min(requestedHistoryBudgetTokens, historyCapacity),
      estimator,
    );
    const historyConversation = history.messages;
    const conversation: ModelMessage[] = [
      ...historyConversation,
      currentInputMessage,
    ];
    const settledExchanges: SettledActionExchange[] = [];
    let finalText = "";

    for (let stepNumber = 1; stepNumber <= request.maxSteps; stepNumber += 1) {
      if (
        goalEngine
        && frozenGoalBinding
        && goalAttemptsAlreadyExhausted(writer.view, frozenGoalBinding.goalId)
      ) {
        const attempts = writer.view?.goals[frozenGoalBinding.goalId]?.resources.attempts;
        writer.append(
          "run.parked",
          {
            runId,
            reason: "budget",
            detail: `attempts budget exhausted at ${attempts?.consumed ?? 0}/${attempts?.limit ?? 0}`,
          },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, "parked", finalText);
      }
      const finalHandoffStep = request.reserveFinalHandoff === true && stepNumber === request.maxSteps;
      const budgetWarningStep = request.reserveFinalHandoff === true && stepNumber === request.maxSteps - 1;
      const workPlanBlock = createWorkPlanNavigationBlock(writer.view, frozenMode);
      const goalBlock = frozenGoalBinding
        ? createGoalContextBlockForView(writer.view, frozenGoalBinding.goalId)
        : undefined;
      const stepContextBlocks = [
        ...request.contextBlocks,
        ...(history.factsBlock ? [history.factsBlock] : []),
        ...(history.omissionBlock ? [history.omissionBlock] : []),
        ...(workPlanBlock ? [workPlanBlock] : []),
        ...(goalBlock ? [goalBlock] : []),
        ...(budgetWarningStep ? [createBudgetWarningBlock(stepNumber, request.maxSteps)] : []),
        ...(finalHandoffStep ? [createBudgetHandoffBlock(stepNumber, request.maxSteps)] : []),
      ];
      const stepId = createId("stp") as StepId;
      writer.append("step.started", { runId, stepId }, { kind: "runtime", id: "qi" });
      const modeTools = toolsForMode(frozenMode, registeredNames);
      const allowlist = request.toolAllowlist
        ? modeTools.filter((name) => request.toolAllowlist!.includes(name))
        : modeTools;
      const catalog = finalHandoffStep ? [] : this.#toolRegistry.catalog({ tools: allowlist });
      const toolCatalogTokens = estimateToolCatalog(catalog.map((tool) => tool.model), estimator);

      let compiled;
      try {
        const pressureThreshold = Math.floor(request.contextBudgetTokens * contextPressureRatio);
        if (estimateMessages(conversation, estimator) + toolCatalogTokens > pressureThreshold) {
          await this.#compactExchanges({
            writer,
            request,
            runId,
            stepId,
            conversation,
            settledExchanges,
            targetTokens: Math.max(
              1,
              Math.floor(request.contextBudgetTokens * contextPressureTargetRatio) - toolCatalogTokens,
            ),
            includeUnconsumed: false,
            reason: "pressure",
          });
        }
        try {
          compiled = compileTurnContext(request, conversation, toolCatalogTokens, stepContextBlocks);
        } catch (error) {
          if (!(error instanceof ContextBudgetError)) throw error;
          const compacted = await this.#compactExchanges({
            writer,
            request,
            runId,
            stepId,
            conversation,
            settledExchanges,
            targetTokens: Math.max(
              1,
              Math.floor(request.contextBudgetTokens * contextPressureTargetRatio) - toolCatalogTokens,
            ),
            includeUnconsumed: true,
            reason: "hard-limit",
          });
          if (!compacted) throw error;
          compiled = compileTurnContext(request, conversation, toolCatalogTokens, stepContextBlocks);
        }
        const conversationTokens = estimateMessages(conversation, estimator);
        writer.append(
          "context.compiled",
          {
            runId,
            stepId,
            includedBlockIds: [
              ...compiled.included.map((block) => block.id),
              "tool-catalog",
              ...conversation.map((_, index) => index < historyConversation.length
                ? `history:${index}`
                : `conversation:${index - historyConversation.length}`),
            ],
            omittedBlockIds: [
              ...compiled.omitted.map((block) => block.id),
              ...history.omittedRunIds.map((omittedRunId) => `history:omitted:${omittedRunId}`),
            ],
            blockStats: compiled.blockStats,
            estimatedTokens: compiled.estimatedTokens + conversationTokens + toolCatalogTokens,
            budgetTokens: request.contextBudgetTokens,
          },
          { kind: "runtime", id: "context_compiler" },
        );
      } catch (error) {
        if (finalHandoffStep && !request.signal?.aborted) {
          finalText = deterministicBudgetHandoff(writer.view, runId, request.maxSteps, error);
          writer.append(
            "step.completed",
            { runId, stepId, finishReason: "handoff" },
            { kind: "runtime", id: "qi" },
          );
          writer.append(
            "run.parked",
            { runId, reason: "budget", detail: `Reached maxSteps=${request.maxSteps}; deterministic handoff generated` },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: "error" },
          { kind: "runtime", id: "qi" },
        );
        if (error instanceof ContextBudgetError) {
          writer.append(
            "run.parked",
            { runId, reason: "budget", detail: error.message },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        writer.append(
          "run.failed",
          {
            runId,
            code: error instanceof ContextCompactionError ? "CONTEXT_COMPACT" : "CONTEXT_COMPILE",
            diagnosticRef: errorRef(error),
          },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, "failed", finalText);
      }

      const advertised = new Map(catalog.map((tool) => [tool.name, tool]));
      const requestId = `request-${randomUUID()}`;
      let modelResult: AggregatedModelResult;
      try {
        const modelInput = redactSensitiveValue([...compiled.messages, ...conversation]);
        this.#recordRedactions(writer, "model-input", modelInput.redactions, { runId, stepId });
        const materializedMessages = await materializeArtifactImages(
          modelInput.value,
          request.artifactStore,
        );
        modelResult = await aggregateModelEvents(
          this.#modelPort.stream(
            {
              requestId,
              model: request.model,
              messages: materializedMessages,
              tools: catalog.map((tool) => tool.model),
              ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
              metadata: {
                sessionId: request.sessionId,
                runId,
                stepId,
              },
            },
            request.signal,
          ),
          (text) => this.#onActivity?.({
            type: "model.text",
            sessionId: request.sessionId,
            runId,
            stepId,
            text,
            provisional: true,
          }),
          (text) => this.#onActivity?.({
            type: "model.reasoning",
            sessionId: request.sessionId,
            runId,
            stepId,
            text,
            provisional: true,
          }),
        );
      } catch (error) {
        if (finalHandoffStep && !request.signal?.aborted) {
          finalText = deterministicBudgetHandoff(writer.view, runId, request.maxSteps, error);
          writer.append(
            "step.completed",
            { runId, stepId, finishReason: "handoff" },
            { kind: "runtime", id: "qi" },
          );
          writer.append(
            "run.parked",
            { runId, reason: "budget", detail: `Reached maxSteps=${request.maxSteps}; deterministic handoff generated` },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: "error" },
          { kind: "runtime", id: "qi" },
        );
        const cancelled = request.signal?.aborted ?? false;
        writer.append(
          cancelled ? "run.cancelled" : "run.failed",
          cancelled
            ? { runId, reason: "Model request cancelled" }
            : { runId, code: "MODEL_TRANSPORT", diagnosticRef: errorRef(error) },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, cancelled ? "cancelled" : "failed", finalText);
      }

      if (modelResult.terminal.type === "failed") {
        if (finalHandoffStep) {
          finalText = deterministicBudgetHandoff(
            writer.view,
            runId,
            request.maxSteps,
            new Error(`${modelResult.terminal.code}: ${modelResult.terminal.message}`),
          );
          writer.append(
            "step.completed",
            { runId, stepId, finishReason: "handoff" },
            { kind: "runtime", id: "qi" },
          );
          writer.append(
            "run.parked",
            { runId, reason: "budget", detail: `Reached maxSteps=${request.maxSteps}; deterministic handoff generated` },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: "error" },
          { kind: "runtime", id: "qi" },
        );
        writer.append(
          "run.failed",
          { runId, code: modelResult.terminal.code },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, "failed", finalText);
      }
      const completedTerminal = modelResult.terminal;
      for (const exchange of settledExchanges) exchange.consumed = true;

      const safeText = redactSensitiveText(modelResult.text);
      const safeReasoning = redactSensitiveText(modelResult.reasoning);
      this.#recordRedactions(
        writer,
        "model-output",
        mergeRedactionSummaries(safeText.redactions, safeReasoning.redactions),
        { runId, stepId },
      );
      modelResult.text = stripReservedRunFacts(safeText.value);
      modelResult.reasoning = safeReasoning.value;

      writer.append(
        "model.completed",
        {
          runId,
          stepId,
          requestId,
          provider: request.model.provider,
          model: request.model.model,
          finishReason: completedTerminal.finishReason,
          text: modelResult.text,
          ...(modelResult.reasoning ? { reasoning: modelResult.reasoning } : {}),
          actionCalls: modelResult.actions,
          ...(modelResult.usage ? { usage: modelResult.usage } : {}),
        },
        { kind: "agent", id: request.subject },
      );

      const assistantContent: ModelMessage["content"] = [];
      if (modelResult.text) assistantContent.push({ type: "text", text: modelResult.text });
      for (const action of modelResult.actions) {
        assistantContent.push({ type: "tool-call", callId: action.callId, name: action.name, input: action.input });
      }
      const assistantMessage: ModelMessage = { role: "assistant", content: assistantContent };
      conversation.push(assistantMessage);
      finalText = modelResult.text || (
        finalHandoffStep
          ? deterministicBudgetHandoff(writer.view, runId, request.maxSteps)
          : modelResult.text
      );

      if (finalHandoffStep) {
        for (const action of modelResult.actions) {
          writer.append(
            "model.action.rejected",
            {
              runId,
              stepId,
              callId: action.callId,
              toolName: action.name,
              errorCode: "ACTION_BATCH_LIMIT",
              reason: "The final budget handoff Step has an Action budget of zero",
            },
            { kind: "runtime", id: "budget_guard" },
          );
        }
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: "handoff" },
          { kind: "runtime", id: "qi" },
        );
        writer.append(
          "run.parked",
          { runId, reason: "budget", detail: `Reached maxSteps=${request.maxSteps}; handoff recorded` },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, "parked", finalText);
      }

      if (modelResult.actions.length === 0) {
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: completedTerminal.finishReason === "length" ? "error" : "response" },
          { kind: "runtime", id: "qi" },
        );
      if (
        consumeGoalTokens({
          ...(goalEngine === undefined ? {} : { goalEngine }),
          ...(frozenGoalBinding === undefined ? {} : { goalBinding: frozenGoalBinding }),
          ...(writer.view === undefined ? {} : { view: writer.view }),
          runId,
          ...(modelResult.usage === undefined ? {} : { usage: modelResult.usage }),
          reason: `model ${requestId}`,
        })
      ) {
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        if (completedTerminal.finishReason === "length") {
          writer.append(
            "run.parked",
            { runId, reason: "budget", detail: "Model output reached its length boundary" },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        if (
          request.requiredCompletionTool
          && !Object.values(writer.view?.runs[runId]?.actions ?? {}).some(
            (action) =>
              action.toolName === request.requiredCompletionTool!.toolName
              && (
                request.requiredCompletionTool!.effect === undefined
                || action.effect === request.requiredCompletionTool!.effect
              )
              && action.status === "completed",
          )
        ) {
          const finalActionStep = request.reserveFinalHandoff === true
            ? request.maxSteps - 1
            : request.maxSteps;
          if (stepNumber >= finalActionStep) {
            writer.append(
              "run.parked",
              {
                runId,
                reason: request.requiredCompletionTool.parkReason,
                detail:
                  `Required ${request.requiredCompletionTool.effect
                    ? `${request.requiredCompletionTool.effect} `
                    : ""}${request.requiredCompletionTool.toolName} was not completed`,
              },
              { kind: "runtime", id: "completion_guard" },
            );
            return this.#result(writer, request.sessionId, runId, "parked", finalText);
          }
          conversation.push({
            role: "user",
            content: [{ type: "text", text: request.requiredCompletionTool.correction }],
          });
          continue;
        }
        if (this.#consumeSteering(writer, request.sessionId, runId, conversation) > 0) {
          continue;
        }
        writer.append(
          "run.completed",
          { runId, completionKind: "response", evaluationIds: [] },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, "completed", finalText);
      }

      const candidates: CandidateCall[] = [];
      const rejectedCalls: RejectedModelCall[] = [];
      const toolResults = new Map<string, ToolResultPart>();
      try {
        const callIds = new Set<string>();
        for (const action of modelResult.actions) {
          if (!advertised.has(action.name)) throw new Error(`Model requested unadvertised tool ${action.name}`);
          if (callIds.has(action.callId)) throw new Error(`Model repeated action call ID ${action.callId}`);
          callIds.add(action.callId);
        }
        for (const [actionIndex, action] of modelResult.actions.entries()) {
          const registration = advertised.get(action.name);
          if (!registration) throw new Error(`Missing advertised registration for ${action.name}`);
          if (actionIndex >= maxActionsPerStep) {
            rejectedCalls.push({
              callId: action.callId,
              toolName: action.name,
              errorCode: "ACTION_BATCH_LIMIT",
              reason: `Step action batch limit ${maxActionsPerStep} exceeded; reassess completed results before proposing more actions`,
            });
            continue;
          }
          if (!isToolAllowedInMode(frozenMode, action.name)) {
            rejectedCalls.push({
              callId: action.callId,
              toolName: action.name,
              errorCode: "TOOL_INPUT",
              reason: `${frozenMode} mode denies tool ${action.name}`,
            });
            continue;
          }
          const actionId = createId("act");
          const toolContext: ToolExecutionContext = {
            sessionId: request.sessionId,
            runId,
            stepId,
            actionId,
            subject: request.subject,
            workspaceRoot: request.workspaceRoot,
            artifactStore: request.artifactStore,
            mode: frozenMode,
            mounts: request.getMounts?.() ?? [],
            ...(request.getMounts === undefined ? {} : { getMounts: request.getMounts }),
            sensitivePathGrants: request.getSensitivePathGrants?.() ?? [],
            ...(request.getSensitivePathGrants === undefined
              ? {}
              : { getSensitivePathGrants: request.getSensitivePathGrants }),
            ...(request.sensitivePathPolicy === undefined
              ? {}
              : { sensitivePathPolicy: request.sensitivePathPolicy }),
            ...(request.effectJournal === undefined ? {} : { effectJournal: request.effectJournal }),
            idempotencyScope: runId,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(this.#onActivity === undefined ? {} : {
              reportActivity: (activity) => this.#onActivity?.({
                type: "action.output",
                sessionId: request.sessionId,
                runId,
                stepId,
                actionId,
                stream: activity.stream,
                text: activity.text,
                truncated: activity.truncated,
                provisional: true,
              }),
            }),
          };
          try {
            const inspected = this.#toolRegistry.inspect(action.name, registration.identity, action.input, toolContext);
            const modeGate = modeAllowsIntent(frozenMode, inspected.name, inspected.effect);
            if (!modeGate.ok) {
              rejectedCalls.push({
                callId: action.callId,
                toolName: action.name,
                errorCode: "TOOL_INPUT",
                reason: modeGate.reason,
              });
              continue;
            }
            candidates.push({ callId: action.callId, actionId, inspected, context: toolContext });
          } catch (error) {
            if (!(error instanceof ToolInputError)) throw error;
            rejectedCalls.push({
              callId: action.callId,
              toolName: action.name,
              errorCode: "TOOL_INPUT",
              reason: error.message,
            });
          }
        }
        for (const rejected of rejectedCalls) {
          writer.append(
            "model.action.rejected",
            { runId, stepId, ...rejected },
            { kind: "runtime", id: "tool_registry" },
          );
          toolResults.set(rejected.callId, {
            type: "tool-result",
            callId: rejected.callId,
            output: { code: rejected.errorCode, reason: rejected.reason },
            isError: true,
          });
        }
        const accepted: CandidateCall[] = [];
        for (const candidate of candidates) {
          try {
            writer.append(
              "action.proposed",
              {
                runId,
                stepId,
                actionId: candidate.actionId,
                toolName: candidate.inspected.name,
                toolIdentity: candidate.inspected.identity,
                input: candidate.inspected.input,
                effect: candidate.inspected.effect,
                resources: [...candidate.inspected.resources],
              },
              { kind: "agent", id: request.subject },
            );
            accepted.push(candidate);
          } catch (error) {
            // Kernel mode hard-gate is a recoverable model correction path when it
            // drifts from pre-proposal checks; other transition faults stay fatal.
            if (
              error instanceof StateTransitionError &&
              (error.code === "MODE_TOOL_DENIED" || error.code === "MODE_EFFECT_DENIED")
            ) {
              writer.append(
                "model.action.rejected",
                {
                  runId,
                  stepId,
                  callId: candidate.callId,
                  toolName: candidate.inspected.name,
                  errorCode: "TOOL_INPUT",
                  reason: error.message,
                },
                { kind: "runtime", id: "kernel" },
              );
              toolResults.set(candidate.callId, {
                type: "tool-result",
                callId: candidate.callId,
                output: { code: "TOOL_INPUT", reason: error.message },
                isError: true,
              });
              continue;
            }
            throw error;
          }
        }
        candidates.length = 0;
        candidates.push(...accepted);
      } catch (error) {
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: "error" },
          { kind: "runtime", id: "qi" },
        );
        writer.append(
          "run.failed",
          { runId, code: "INVALID_MODEL_ACTION", diagnosticRef: errorRef(error) },
          { kind: "runtime", id: "qi" },
        );
        return this.#result(writer, request.sessionId, runId, "failed", finalText);
      }

      writer.append(
        "step.completed",
        { runId, stepId, finishReason: "action-requested" },
        { kind: "runtime", id: "qi" },
      );
      if (
        consumeGoalTokens({
          ...(goalEngine === undefined ? {} : { goalEngine }),
          ...(frozenGoalBinding === undefined ? {} : { goalBinding: frozenGoalBinding }),
          ...(writer.view === undefined ? {} : { view: writer.view }),
          runId,
          ...(modelResult.usage === undefined ? {} : { usage: modelResult.usage }),
          reason: `model ${requestId}`,
        })
      ) {
        consumeGoalAttemptForNonReadStep({
          ...(goalEngine === undefined ? {} : { goalEngine }),
          ...(frozenGoalBinding === undefined ? {} : { goalBinding: frozenGoalBinding }),
          ...(writer.view === undefined ? {} : { view: writer.view }),
          runId,
          stepId,
          stepNumber,
        });
        return this.#result(writer, request.sessionId, runId, "parked", finalText);
      }

      const successfulWrites = new Map<string, SuccessfulStepWrite>();
      const lastMutationAttempts = new Map<string, StepMutationAttempt>();
      const candidateExecutionArgs = {
        writer,
        runId,
        stepId,
        request,
        successfulWrites,
        lastMutationAttempts,
        toolResults,
        ...(goalEngine === undefined ? {} : { goalEngine }),
        ...(frozenGoalBinding === undefined ? {} : { goalBinding: frozenGoalBinding }),
      };
      const chargeAttemptAfterTerminal = (): void => {
        consumeGoalAttemptForNonReadStep({
          ...(goalEngine === undefined ? {} : { goalEngine }),
          ...(frozenGoalBinding === undefined ? {} : { goalBinding: frozenGoalBinding }),
          ...(writer.view === undefined ? {} : { view: writer.view }),
          runId,
          stepId,
          stepNumber,
        });
      };
      let candidateIndex = 0;
      while (candidateIndex < candidates.length) {
        const candidate = candidates[candidateIndex];
        if (!candidate) throw new Error(`Missing candidate at index ${candidateIndex}`);
        // Non-read (write/execute/publish/spend) Actions stay strictly one-at-a-time: file/artifact
        // BATCH_WRITE_CONFLICT detection, edit freshness-chain rebasing, and "stop the batch on an
        // indeterminate settlement" all depend on `successfulWrites`/`lastMutationAttempts` reflecting
        // every earlier content-bearing write in this Step before the next one is inspected.
        // Host execute resources are excluded from that conflict table so sequential shells may share a workdir.
        if (candidate.inspected.effect !== "read") {
          const outcome = await this.#executeCandidate(candidate, candidateExecutionArgs);
          if (outcome === "cancelled") {
            this.#denyUnstartedCandidates(
              writer,
              runId,
              stepId,
              candidates.slice(candidateIndex + 1),
              "Batch cancelled before this action started",
            );
            writer.append(
              "run.cancelled",
              { runId, reason: "User interrupted the active tool" },
              { kind: "runtime", id: "qi" },
            );
            chargeAttemptAfterTerminal();
            return this.#result(writer, request.sessionId, runId, "cancelled", finalText);
          }
          if (outcome === "indeterminate") {
            this.#denyUnstartedCandidates(
              writer,
              runId,
              stepId,
              candidates.slice(candidateIndex + 1),
              "Batch stopped because a prior action has an indeterminate effect",
            );
            writer.append(
              "run.parked",
              {
                runId,
                reason: "indeterminate-effect",
                detail: parkDetailForIndeterminate(writer.view?.runs[runId]),
              },
              { kind: "runtime", id: "qi" },
            );
            chargeAttemptAfterTerminal();
            return this.#result(writer, request.sessionId, runId, "parked", finalText);
          }
          if (writer.view?.runs[runId]?.status === "parked") {
            this.#denyUnstartedCandidates(
              writer,
              runId,
              stepId,
              candidates.slice(candidateIndex + 1),
              "Batch stopped because Goal convergence parked the Run",
            );
            chargeAttemptAfterTerminal();
            return this.#result(writer, request.sessionId, runId, "parked", finalText);
          }
          candidateIndex += 1;
          continue;
        }
        // Read effects never consult or mutate `successfulWrites`/`lastMutationAttempts`, so a maximal
        // consecutive run of read candidates can authorize+execute concurrently: per-actionId Kernel
        // transitions don't require one Action to settle before another starts, and the model-facing
        // tool-result order is reconstructed from `modelResult.actions` afterward, independent of
        // completion order (see the `exchangeMessages` build below).
        let readRunEnd = candidateIndex + 1;
        while (readRunEnd < candidates.length && candidates[readRunEnd]?.inspected.effect === "read") {
          readRunEnd += 1;
        }
        const readRun = candidates.slice(candidateIndex, readRunEnd);
        const outcomes = await Promise.all(
          readRun.map((readCandidate) => this.#executeCandidate(readCandidate, candidateExecutionArgs)),
        );
        // Every member of this run already started concurrently by the time Promise.all resolves, so a
        // cancellation or indeterminate settlement inside the run cannot retroactively "un-start" its
        // siblings — only candidates strictly after the whole run are still eligible for denial.
        if (outcomes.includes("cancelled")) {
          this.#denyUnstartedCandidates(
            writer,
            runId,
            stepId,
            candidates.slice(readRunEnd),
            "Batch cancelled before this action started",
          );
          writer.append(
            "run.cancelled",
            { runId, reason: "User interrupted the active tool" },
            { kind: "runtime", id: "qi" },
          );
          chargeAttemptAfterTerminal();
          return this.#result(writer, request.sessionId, runId, "cancelled", finalText);
        }
        if (outcomes.includes("indeterminate")) {
          this.#denyUnstartedCandidates(
            writer,
            runId,
            stepId,
            candidates.slice(readRunEnd),
            "Batch stopped because a prior action has an indeterminate effect",
          );
          writer.append(
            "run.parked",
            {
              runId,
              reason: "indeterminate-effect",
              detail: parkDetailForIndeterminate(writer.view?.runs[runId]),
            },
            { kind: "runtime", id: "qi" },
          );
          chargeAttemptAfterTerminal();
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        if (writer.view?.runs[runId]?.status === "parked") {
          this.#denyUnstartedCandidates(
            writer,
            runId,
            stepId,
            candidates.slice(readRunEnd),
            "Batch stopped because Goal convergence parked the Run",
          );
          chargeAttemptAfterTerminal();
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
        candidateIndex = readRunEnd;
      }
      const exchangeMessages: ModelMessage[] = [assistantMessage];
      for (const action of modelResult.actions) {
        const result = toolResults.get(action.callId);
        if (result) {
          const toolMessage: ModelMessage = { role: "tool", content: [result] };
          conversation.push(toolMessage);
          exchangeMessages.push(toolMessage);
        }
      }
      settledExchanges.push({ sourceStepId: stepId, messages: exchangeMessages, consumed: false, compacted: false });
      this.#consumeSteering(writer, request.sessionId, runId, conversation);
      if (
        consumeGoalAttemptForNonReadStep({
          ...(goalEngine === undefined ? {} : { goalEngine }),
          ...(frozenGoalBinding === undefined ? {} : { goalBinding: frozenGoalBinding }),
          ...(writer.view === undefined ? {} : { view: writer.view }),
          runId,
          stepId,
          stepNumber,
        })
      ) {
        return this.#result(writer, request.sessionId, runId, "parked", finalText);
      }
    }

    writer.append(
      "run.parked",
      { runId, reason: "budget", detail: `Reached maxSteps=${request.maxSteps}` },
      { kind: "runtime", id: "qi" },
    );
    return this.#result(writer, request.sessionId, runId, "parked", finalText);
  }

  #result(
    writer: EventWriter,
    sessionId: SessionId,
    runId: RunId,
    status: TurnResult["status"],
    text: string,
  ): TurnResult {
    // GoalEngine appends resource/park events on the same store without going through EventWriter;
    // reload so callers see attempts consumption and Goal-paused parks.
    const view = this.#eventStore.load(sessionId) ?? writer.view;
    if (!view) throw new Error("TurnLoop ended without a Session view");
    return { sessionId, runId, status, text, view };
  }

  /**
   * Run one candidate's freshness-rebase, authorize, and execute sequence, recording every event this
   * candidate needs on its own. Returns an outcome discriminant instead of denying later candidates or
   * ending the Run itself, so the caller can batch calls (concurrently for read effects) and still decide
   * once — after every outcome in a batch is known — whether to stop remaining candidates.
   */
  async #executeCandidate(
    candidate: CandidateCall,
    args: {
      writer: EventWriter;
      runId: RunId;
      stepId: StepId;
      request: TurnRequest;
      successfulWrites: Map<string, SuccessfulStepWrite>;
      lastMutationAttempts: Map<string, StepMutationAttempt>;
      toolResults: Map<string, ToolResultPart>;
      goalEngine?: GoalEngine;
      goalBinding?: RunGoalBinding;
    },
  ): Promise<"settled" | "denied" | "failed" | "cancelled" | "indeterminate"> {
    const {
      writer,
      runId,
      stepId,
      request,
      successfulWrites,
      lastMutationAttempts,
      toolResults,
      goalEngine,
      goalBinding,
    } = args;
    let inspected = candidate.inspected;
    let context = candidate.context;
    let chainedEdit = false;
    let rebaseFailure: ToolFailure | undefined;
    const priorWrites = inspected.effect === "read"
      ? []
      : conflictResources(inspected.resources)
          .map((resource) => ({ resource, write: successfulWrites.get(resource) }))
          .filter((entry): entry is { resource: string; write: SuccessfulStepWrite } => entry.write !== undefined);
    if (
      priorWrites.length === 1
      && inspected.name === "edit"
      && inspected.resources.length === 1
      && priorWrites[0]?.write.toolName === "edit"
      && priorWrites[0].write.editChain
      && lastMutationAttempts.get(priorWrites[0].resource)?.actionId === priorWrites[0].write.actionId
    ) {
      const prior = priorWrites[0];
      const input = objectRecord(inspected.input);
      const expectedSha256 = typeof input?.expectedSha256 === "string" ? input.expectedSha256 : undefined;
      const chain = prior.write.editChain!;
      if (expectedSha256 === chain.latestSha256) {
        chainedEdit = true;
      } else if (expectedSha256 === chain.originalSha256) {
        const effectiveInput = { ...input, expectedSha256: chain.latestSha256 };
        context = {
          ...context,
          freshnessRebase: {
            priorActionId: prior.write.actionId,
            originalExpectedSha256: expectedSha256,
          },
        };
        try {
          const rebased = this.#toolRegistry.inspect(
            inspected.name,
            inspected.identity,
            effectiveInput,
            context,
          );
          if (
            rebased.effect !== inspected.effect
            || !sameResources(rebased.resources, inspected.resources)
            || rebased.name !== "edit"
          ) {
            throw new Error("re-inspection changed the tool effect or resources");
          }
          writer.append(
            "action.freshness.rebased",
            {
              runId,
              stepId,
              actionId: candidate.actionId,
              priorActionId: prior.write.actionId,
              resource: prior.resource,
              originalExpectedSha256: expectedSha256,
              effectiveExpectedSha256: chain.latestSha256,
            },
            { kind: "runtime", id: "tool_registry" },
          );
          inspected = rebased;
          chainedEdit = true;
        } catch (error) {
          rebaseFailure = new ToolFailure(
            "EDIT_REBASE_INVALID",
            `Could not safely re-inspect edit ${candidate.actionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    writer.append(
      "authority.requested",
      { runId, stepId, actionId: candidate.actionId },
      { kind: "runtime", id: "capability_broker" },
    );
    let authorized;
    try {
      authorized = await inspected.authorize();
    } catch (error) {
      const reason =
        error instanceof AuthorityDeniedError
          ? error.reason
          : `Authorization unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const policyTrace = error instanceof AuthorityDeniedError ? error.policyTrace : [];
      writer.append(
        "authority.denied",
        {
          runId,
          stepId,
          actionId: candidate.actionId,
          reason,
          ...(policyTrace.length === 0 ? {} : { policyTrace: [...policyTrace] }),
        },
        { kind: "runtime", id: "capability_broker" },
      );
      toolResults.set(candidate.callId, {
        type: "tool-result",
        callId: candidate.callId,
        output: { code: "AUTHORITY_DENIED", reason },
        isError: true,
      });
      if (inspected.effect !== "read") {
        for (const resource of conflictResources(inspected.resources)) {
          lastMutationAttempts.set(resource, {
            actionId: candidate.actionId,
            toolName: inspected.name,
            status: "denied",
          });
        }
      }
      return "denied";
    }

    writer.append(
      "authority.granted",
      {
        runId,
        stepId,
        actionId: candidate.actionId,
        leaseId: authorized.leaseId,
        policyTrace: [...authorized.policyTrace],
      },
      { kind: "runtime", id: "capability_broker" },
    );
    writer.append(
      "action.started",
      { runId, stepId, actionId: candidate.actionId },
      { kind: "runtime", id: "tool_runner" },
    );

    try {
      if (rebaseFailure) throw rebaseFailure;
      if (inspected.effect !== "read") {
        const overlap = conflictResources(inspected.resources).filter((resource) => successfulWrites.has(resource));
        if (overlap.length > 0 && !chainedEdit) {
          throw new ToolFailure(
            "BATCH_WRITE_CONFLICT",
            inspected.name === "edit"
              ? `A prior write in this Step already changed ${overlap.join(", ")}; re-read that path, then edit with the new expectedSha256`
              : `A prior non-read Action in this Step already targeted ${overlap.join(", ")}; submit the dependent mutation in a later Step after a fresh observation`,
          );
        }
      }
      const settlement = await authorized.execute();
      this.#recordRedactions(writer, "tool-output", settlement.redactions ?? [], {
        runId,
        stepId,
        actionId: candidate.actionId,
      });
      const outputRef = extractOutputRef(settlement.output);
      writer.append(
        "action.completed",
        {
          runId,
          stepId,
          actionId: candidate.actionId,
          ...(outputRef ? { outputRef } : {}),
          modelOutput: settlement.modelOutput,
        },
        { kind: "runtime", id: "tool_runner" },
      );
      if (inspected.effect !== "read") {
        const input = objectRecord(inspected.input);
        const output = objectRecord(settlement.output);
        for (const resource of conflictResources(inspected.resources)) {
          const prior = successfulWrites.get(resource);
          const expectedSha256 = typeof input?.expectedSha256 === "string" ? input.expectedSha256 : undefined;
          const latestSha256 = typeof output?.sha256 === "string" ? output.sha256 : undefined;
          successfulWrites.set(resource, {
            actionId: candidate.actionId,
            toolName: inspected.name,
            ...(inspected.name === "edit" && expectedSha256 && latestSha256
              ? {
                  editChain: {
                    originalSha256: prior?.editChain?.originalSha256 ?? expectedSha256,
                    latestSha256,
                  },
                }
              : {}),
          });
          lastMutationAttempts.set(resource, {
            actionId: candidate.actionId,
            toolName: inspected.name,
            status: "completed",
          });
        }
      }
      toolResults.set(candidate.callId, {
        type: "tool-result",
        callId: candidate.callId,
        output: settlement.modelOutput,
        isError: false,
      });
      return "settled";
    } catch (error) {
      if (request.signal?.aborted) {
        writer.append(
          "action.cancelled",
          { runId, stepId, actionId: candidate.actionId, reason: "Tool call cancelled" },
          { kind: "runtime", id: "tool_runner" },
        );
        return "cancelled";
      }
      if (error instanceof ToolFailure) {
        const failure = redactSensitiveValue({
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
        this.#recordRedactions(writer, "tool-output", failure.redactions, {
          runId,
          stepId,
          actionId: candidate.actionId,
        });
        const modelOutput = [{ type: "text" as const, text: JSON.stringify(failure.value) }];
        writer.append(
          "action.failed",
          { runId, stepId, actionId: candidate.actionId, errorCode: error.code, modelOutput },
          { kind: "runtime", id: "tool_runner" },
        );
        if (goalEngine && goalBinding) {
          const assertionId = primaryGoalAssertionId(writer.view, goalBinding.goalId);
          if (assertionId) {
            try {
              goalEngine.recordFailure({
                goalId: goalBinding.goalId,
                runId,
                stepId,
                assertionId,
                evaluatorIdentity: `tool:${inspected.name}`,
                errorCode: error.code,
                targetResources: [...inspected.resources],
              });
            } catch {
              // Failure accounting must not override Action settlement; stagnation park is best-effort.
            }
          }
        }
        toolResults.set(candidate.callId, {
          type: "tool-result",
          callId: candidate.callId,
          output: modelOutput,
          isError: true,
        });
        if (inspected.effect !== "read") {
          for (const resource of conflictResources(inspected.resources)) {
            lastMutationAttempts.set(resource, {
              actionId: candidate.actionId,
              toolName: inspected.name,
              status: "failed",
            });
          }
        }
        return "failed";
      }

      writer.append(
        "action.indeterminate",
        {
          runId,
          stepId,
          actionId: candidate.actionId,
          reason: error instanceof Error ? error.message : "Unknown executor failure",
          reconciliationHint: "Inspect the Effect Journal before retrying this action",
        },
        { kind: "runtime", id: "tool_runner" },
      );
      return "indeterminate";
    }
  }

  #denyUnstartedCandidates(
    writer: EventWriter,
    runId: RunId,
    stepId: StepId,
    candidates: readonly CandidateCall[],
    reason: string,
  ): void {
    for (const candidate of candidates) {
      writer.append(
        "authority.requested",
        { runId, stepId, actionId: candidate.actionId },
        { kind: "runtime", id: "capability_broker" },
      );
      writer.append(
        "authority.denied",
        { runId, stepId, actionId: candidate.actionId, reason },
        { kind: "runtime", id: "capability_broker" },
      );
    }
  }

  #recordRedactions(
    writer: EventWriter,
    boundary: "model-input" | "model-output" | "tool-output" | "context-compact",
    redactions: readonly RedactionSummary[],
    refs: { runId: RunId; stepId?: StepId; actionId?: string },
  ): void {
    if (redactions.length === 0) return;
    writer.append(
      "safety.redaction.applied",
      { boundary, ...refs, redactions: [...redactions] },
      { kind: "runtime", id: "safety_filter" },
    );
  }

  async #compactExchanges(input: {
    writer: EventWriter;
    request: TurnRequest;
    runId: RunId;
    stepId: StepId;
    conversation: ModelMessage[];
    settledExchanges: SettledActionExchange[];
    targetTokens: number;
    includeUnconsumed: boolean;
    reason: "pressure" | "hard-limit";
  }): Promise<boolean> {
    let changed = false;
    for (const exchange of input.settledExchanges) {
      const estimator = input.request.tokenEstimator ?? approximateTokenEstimator;
      if (estimateMessages(input.conversation, estimator) <= input.targetTokens) break;
      if (exchange.compacted || (!exchange.consumed && !input.includeUnconsumed)) continue;
      const originalEstimatedTokens = estimateMessages(exchange.messages, estimator);
      const sanitized = redactSensitiveValue(exchange.messages);
      const sanitizedMessages = sanitized.value as ModelMessage[];
      const placeholderRef = `artifact://${"0".repeat(64)}`;
      const previewMessage: ModelMessage = {
        role: "system",
        content: [{
          type: "text",
          text: compactExchangeSummary(exchange.sourceStepId, sanitizedMessages, placeholderRef),
        }],
      };
      const compactedEstimatedTokens = estimateMessages([previewMessage], estimator);
      if (compactedEstimatedTokens >= originalEstimatedTokens) continue;
      const start = input.conversation.indexOf(exchange.messages[0]!);
      if (start < 0 || exchange.messages.some((message, index) => input.conversation[start + index] !== message)) {
        throw new ContextCompactionError(
          `Settled exchange ${exchange.sourceStepId} is not contiguous in working context`,
        );
      }
      let artifact: Awaited<ReturnType<ArtifactStore["put"]>>;
      try {
        artifact = await input.request.artifactStore.put(
          Buffer.from(JSON.stringify(sanitizedMessages)),
          "application/vnd.qi.context-exchange+json",
        );
      } catch (error) {
        throw new ContextCompactionError(
          `Could not archive settled exchange ${exchange.sourceStepId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#recordRedactions(input.writer, "context-compact", sanitized.redactions, {
        runId: input.runId,
        stepId: input.stepId,
      });
      const summary = compactExchangeSummary(exchange.sourceStepId, sanitizedMessages, artifact.ref);
      const compactMessage: ModelMessage = {
        role: "system",
        content: [{ type: "text", text: summary }],
      };
      input.conversation.splice(start, exchange.messages.length, compactMessage);
      const messageCount = exchange.messages.length;
      exchange.messages = [compactMessage];
      exchange.compacted = true;
      input.writer.append(
        "context.compacted",
        {
          runId: input.runId,
          stepId: input.stepId,
          sourceStepId: exchange.sourceStepId,
          artifactRef: artifact.ref,
          originalEstimatedTokens,
          compactedEstimatedTokens,
          messageCount,
          reason: input.reason,
        },
        { kind: "runtime", id: "context_compactor" },
      );
      changed = true;
    }
    return changed;
  }

  #consumeSteering(
    writer: EventWriter,
    sessionId: SessionId,
    runId: RunId,
    conversation: ModelMessage[],
  ): number {
    const messages = this.#steeringMailbox.drain(sessionId);
    for (const message of messages) {
      writer.append(
        "steering.received",
        { runId, message: message.message },
        { kind: "user", id: message.actorId },
      );
      conversation.push({ role: "user", content: [{ type: "text", text: message.message }] });
    }
    return messages.length;
  }
}

async function aggregateModelEvents(
  events: AsyncIterable<ModelEvent>,
  onText?: (text: string) => void,
  onReasoning?: (text: string) => void,
): Promise<AggregatedModelResult> {
  let text = "";
  let reasoning = "";
  const actions: AggregatedModelResult["actions"] = [];
  let usage: AggregatedModelResult["usage"];
  let terminal: AggregatedModelResult["terminal"] | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "text.delta":
        text += event.delta;
        onText?.(stripReservedRunFacts(redactSensitiveText(text).value).slice(-16_000));
        break;
      case "reasoning.delta":
        reasoning += event.delta;
        onReasoning?.(redactSensitiveText(reasoning).value.slice(-16_000));
        break;
      case "action.requested":
        actions.push({ callId: event.callId, name: event.name, input: event.input });
        break;
      case "usage":
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cachedInputTokens === undefined ? {} : { cachedInputTokens: event.cachedInputTokens }),
        };
        break;
      case "completed":
        terminal = {
          type: "completed",
          finishReason: event.finishReason,
          ...(event.responseId === undefined ? {} : { responseId: event.responseId }),
        };
        break;
      case "failed":
        terminal = event;
        break;
    }
  }
  if (!terminal) throw new Error("Model stream ended without a terminal event");
  return {
    text,
    reasoning,
    actions,
    ...(usage === undefined ? {} : { usage }),
    terminal,
  };
}

function extractOutputRef(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const candidate = output as { ref?: unknown; diffRef?: unknown; outputRef?: unknown };
  const ref = candidate.ref ?? candidate.diffRef ?? candidate.outputRef;
  return typeof ref === "string" ? ref : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameResources(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((resource, index) => resource === sortedRight[index]);
}

function compileTurnContext(
  request: TurnRequest,
  conversation: readonly ModelMessage[],
  toolCatalogTokens: number,
  blocks: readonly ContextBlock[] = request.contextBlocks,
) {
  const estimator = request.tokenEstimator ?? approximateTokenEstimator;
  const fixedTokens = estimateMessages(conversation, estimator) + toolCatalogTokens;
  const remaining = request.contextBudgetTokens - fixedTokens;
  if (remaining <= 0) throw new ContextBudgetError(fixedTokens, request.contextBudgetTokens);
  return compileContext({
    blocks,
    budgetTokens: remaining,
    estimator,
  });
}

function createBudgetWarningBlock(stepNumber: number, maxSteps: number): ContextBlock {
  return {
    id: `budget-warning:${stepNumber}`,
    kind: "control",
    source: "qi:runtime",
    role: "system",
    content: [
      `Budget warning: this is Step ${stepNumber} of ${maxSteps}.`,
      "The next and final Step is reserved for a tool-free handoff.",
      "Use this Step for the highest-value remaining action and leave enough context for a concise continuation.",
    ].join("\n"),
    priority: 1_000,
    required: true,
    retentionReason: "The model must know that only one executable Step remains.",
  };
}

function createBudgetHandoffBlock(stepNumber: number, maxSteps: number): ContextBlock {
  return {
    id: `budget-handoff:${stepNumber}`,
    kind: "control",
    source: "qi:runtime",
    role: "system",
    content: [
      `Budget handoff: this is the final Step ${stepNumber} of ${maxSteps}.`,
      "No tools are available and the Action budget is zero. Do not request a tool.",
      "Summarize: (1) completed work and evidence; (2) blockers and unfinished items;",
      "(3) the next 1–3 concrete actions; (4) verification already run and still required.",
      "This Run will be parked for budget after the response; do not claim that the task is complete.",
    ].join("\n"),
    priority: 1_001,
    required: true,
    retentionReason: "The final Step must produce a durable continuation handoff.",
  };
}

function deterministicBudgetHandoff(
  view: SessionView | undefined,
  runId: RunId,
  maxSteps?: number,
  cause?: unknown,
): string {
  const run = view?.runs[runId];
  const actions = run ? Object.values(run.actions) : [];
  const settledActions = actions.filter((action) =>
    ["completed", "failed", "denied", "cancelled", "indeterminate"].includes(action.status)
  );
  const lastAction = actions.at(-1);
  const completedPlanItems = new Set(
    view
      ? Object.values(view.runs)
        .filter((candidate) => candidate.status === "completed" && candidate.planBinding)
        .map((candidate) => candidate.planBinding!.planItemId)
      : [],
  );
  const boundPlan = run?.planBinding;
  const revision = boundPlan === undefined
    ? undefined
    : view?.plans[boundPlan.planId]?.revisions[boundPlan.revision];
  const remainingPlanItems = revision?.items
    .filter((item) => !completedPlanItems.has(item.planItemId))
    .slice(0, 3)
    .map((item) => item.title) ?? [];
  const budgetLabel = maxSteps === undefined ? "the configured Step budget" : `maxSteps=${maxSteps}`;
  const causeText = cause === undefined
    ? ""
    : ` Handoff generation fallback reason: ${cause instanceof Error ? cause.message : String(cause)}.`;
  return [
    `The previous Run was paused after reaching ${budgetLabel}; it was not completed.`,
    `Progress: ${run?.stepOrder.length ?? 0} Steps recorded and ${settledActions.length}/${actions.length} Actions settled.`,
    lastAction
      ? `Last Action: ${lastAction.actionId} (${lastAction.toolName}) ended as ${lastAction.status}.`
      : "Last Action: none recorded.",
    remainingPlanItems.length > 0
      ? `Remaining Plan direction: ${remainingPlanItems.join("; ")}.`
      : "Remaining Plan direction: inspect the latest durable events, then continue the unfinished user request.",
    `Verification: derive completed checks from Action results; re-run any required checks not evidenced in the Session.${causeText}`,
  ].join("\n");
}

function validateTurnContent(input: string, content: readonly RunInputPart[] | undefined): void {
  if (!input.trim() && (content === undefined || content.length === 0)) {
    throw new TypeError("Turn input must contain text or an image");
  }
  if (content === undefined) return;
  const images = content.filter((part) => part.type === "image");
  if (images.length > 8) throw new RangeError("A Turn may contain at most 8 images");
  const preparedBytes = images.reduce((total, image) => total + image.byteLength, 0);
  if (preparedBytes > 20 * 1024 * 1024) {
    throw new RangeError("Prepared images may total at most 20 MiB per Turn");
  }
}

async function assertImageCapability(
  modelPort: ModelPort,
  model: ModelRef,
  content: readonly RunInputPart[] | undefined,
): Promise<void> {
  if (!content?.some((part) => part.type === "image")) return;
  const capabilities = await modelPort.capabilities(model);
  if (!capabilities.input.has("image")) {
    throw new TypeError(
      `Model ${model.provider}/${model.model} does not support image input; switch models or explicitly enable image input for this compatible endpoint`,
    );
  }
}

function toModelInputParts(
  legacyInput: string,
  content: readonly RunInputPart[] | undefined,
  historical: boolean,
): ModelContentPart[] {
  if (content === undefined) return [{ type: "text", text: legacyInput }];
  const result: ModelContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      result.push({ type: "text", text: part.text });
      continue;
    }
    const changes = [
      part.downsampled ? "downsampled" : undefined,
      part.formatChanged ? "format converted" : undefined,
      part.orientationApplied ? "EXIF orientation applied" : undefined,
    ].filter((value): value is string => value !== undefined);
    result.push({
      type: "text",
      text: [
        `[Image attachment (${part.source}): ${part.originalWidth}×${part.originalHeight} ${part.originalMediaType}`,
        `prepared as ${part.width}×${part.height} ${part.mediaType}`,
        changes.length === 0 ? "without visual preprocessing" : changes.join(", "),
        `original ${part.originalArtifactRef}.`,
        "This image is already attached as visual input in this message;",
        "inspect it directly before searching mounts or the Workspace for the same screenshot.]",
      ].join(" "),
    });
    result.push({
      type: "artifact",
      ref: part.preparedArtifactRef,
      mediaType: part.mediaType,
      width: part.width,
      height: part.height,
      ...(historical ? { fallbackText: `[Image unavailable: ${part.originalWidth}×${part.originalHeight}]` } : {}),
    });
  }
  return result;
}

async function materializeArtifactImages(
  messages: readonly ModelMessage[],
  artifactStore: ArtifactStore,
): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    const content: ModelContentPart[] = [];
    for (const part of message.content) {
      content.push(await materializePart(part, artifactStore));
    }
    result.push({ role: message.role, content });
  }
  return result;
}

async function materializePart(
  part: ModelContentPart,
  artifactStore: ArtifactStore,
): Promise<ModelContentPart> {
  if (part.type === "artifact") {
    try {
      return await materializeArtifactPart(part, artifactStore);
    } catch (error) {
      if (part.fallbackText !== undefined) return { type: "text", text: part.fallbackText };
      throw error;
    }
  }
  if (part.type !== "tool-result") return structuredClone(part);
  return {
    ...part,
    output: await materializeNestedArtifacts(part.output, artifactStore),
  };
}

async function materializeNestedArtifacts(value: unknown, artifactStore: ArtifactStore): Promise<unknown> {
  if (isArtifactContentPart(value)) return materializePart(value, artifactStore);
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => materializeNestedArtifacts(item, artifactStore)));
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = await Promise.all(
    Object.entries(value).map(async ([key, item]) => [key, await materializeNestedArtifacts(item, artifactStore)]),
  );
  return Object.fromEntries(entries);
}

function isArtifactContentPart(value: unknown): value is Extract<ModelContentPart, { type: "artifact" }> {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "artifact" &&
    typeof (value as { ref?: unknown }).ref === "string";
}

async function materializeArtifactPart(
  part: Extract<ModelContentPart, { type: "artifact" }>,
  artifactStore: ArtifactStore,
): Promise<Extract<ModelContentPart, { type: "image" }>> {
  const stored = await artifactStore.get(part.ref);
  const digest = createHash("sha256").update(stored.content).digest("hex");
  if (part.ref !== `artifact://${digest}`) {
    throw new ToolFailure("ARTIFACT_DIGEST_MISMATCH", `Artifact digest does not match ${part.ref}`);
  }
  const mediaType = stored.mediaType.trim().toLowerCase();
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)) {
    throw new ToolFailure("ARTIFACT_MEDIA_TYPE", `Artifact ${part.ref} is not a supported image`);
  }
  if (part.mediaType !== undefined && part.mediaType !== mediaType) {
    throw new ToolFailure(
      "ARTIFACT_MEDIA_TYPE",
      `Artifact ${part.ref} media type is ${mediaType}, expected ${part.mediaType}`,
    );
  }
  return {
    type: "image",
    uri: `data:${mediaType};base64,${encodeBase64(stored.content)}`,
    mediaType,
    ...(part.width === undefined ? {} : { width: part.width }),
    ...(part.height === undefined ? {} : { height: part.height }),
  };
}

function encodeBase64(content: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.byteLength; offset += 32_768) {
    chunks.push(String.fromCharCode(...content.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

function estimateMessages(
  messages: readonly ModelMessage[],
  estimator: TokenEstimator = approximateTokenEstimator,
): number {
  let imageTokens = 0;
  const withoutImagePayloads = messages.map((message) => ({
    ...message,
    content: message.content.map((part) => stripImagePayloadForEstimate(part)),
  }));
  function stripImagePayloadForEstimate(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map(stripImagePayloadForEstimate);
    const candidate = value as Record<string, unknown>;
    if (candidate.type === "image" || candidate.type === "artifact") {
      const width = typeof candidate.width === "number" ? candidate.width : 1024;
      const height = typeof candidate.height === "number" ? candidate.height : 1024;
      imageTokens += 85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512);
      return { type: candidate.type, mediaType: candidate.mediaType, width, height };
    }
    return Object.fromEntries(
      Object.entries(candidate).map(([key, item]) => [key, stripImagePayloadForEstimate(item)]),
    );
  }
  const framingTokens = messages.reduce(
    (total, message) => total + 4 + message.content.length * 2,
    2,
  );
  return estimateSerializedTokens(withoutImagePayloads, estimator, framingTokens) + imageTokens;
}

function estimateToolCatalog(
  tools: readonly unknown[],
  estimator: TokenEstimator = approximateTokenEstimator,
): number {
  return estimateSerializedTokens(tools, estimator, tools.length * 8 + 2);
}

function compactExchangeSummary(
  sourceStepId: StepId,
  messages: readonly ModelMessage[],
  artifactRef: string,
): string {
  const calls = messages
    .flatMap((message) => message.content)
    .filter((part): part is Extract<ModelContentPart, { type: "tool-call" }> => part.type === "tool-call");
  const results = new Map(
    messages
      .flatMap((message) => message.content)
      .filter((part): part is ToolResultPart => part.type === "tool-result")
      .map((part) => [part.callId, part]),
  );
  const actions = calls.map((call) => {
    const result = results.get(call.callId);
    const locator = compactInputLocator(call.input);
    return `- ${call.name}${locator ? ` (${locator})` : ""}: ${result?.isError ? "failed" : "completed"}`;
  });
  return [
    `<qi-context-compact source-step="${sourceStepId}">`,
    `Complete settled exchange: ${artifactRef}`,
    ...(actions.length > 0 ? actions : ["- Settled tool exchange; detailed messages omitted."]),
    "The model already consumed the complete exchange unless this was an emergency hard-limit compaction.",
    "Re-read the relevant file or request a narrower inspection before relying on omitted details.",
    "</qi-context-compact>",
  ].join("\n");
}

function compactInputLocator(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const value = input as Record<string, unknown>;
  for (const key of ["path", "file", "profile", "query", "pattern"] as const) {
    if (typeof value[key] === "string" && value[key]) return `${key}=${truncateSummary(value[key], 160)}`;
  }
  if (typeof value.command === "string") {
    const args = Array.isArray(value.args)
      ? value.args.filter((item): item is string => typeof item === "string").slice(0, 4)
      : [];
    return `command=${truncateSummary([value.command, ...args].join(" "), 160)}`;
  }
  return Object.keys(value).slice(0, 8).join(",");
}

function truncateSummary(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function parkDetailForIndeterminate(run: RunView | undefined): string {
  if (!run) return "Tool settlement could not be confirmed";
  return formatIndeterminateParkDetail(run);
}

/** Least-information write settlement for the Runtime-owned restored-history ContextBlock. */
export function formatRunHistoryFacts(run: RunView): string {
  const writes = Object.values(run.actions).filter((action) => action.effect === "write");
  const hasCompleted = writes.some((action) => action.status === "completed");
  const hasUnsuccessful = writes.some((action) => action.status !== "completed");
  const writeSettlement = writes.length === 0
    ? "none"
    : hasCompleted && hasUnsuccessful
      ? "mixed"
      : hasCompleted
        ? "completed"
        : "unsuccessful";
  return `writeSettlement=${writeSettlement}`;
}

const reservedRunFactsPattern = /[ \t]*<qi-run-facts\b[^>\r\n]*\/>[ \t]*/gi;

/** Remove legacy Runtime-reserved fact tags from assistant-authored text before persistence or restoration. */
function stripReservedRunFacts(value: string): string {
  if (!value.includes("<qi-run-facts")) return value;
  return value
    .replace(reservedRunFactsPattern, "")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function compileConversationHistory(
  view: SessionView | undefined,
  budgetTokens: number,
  estimator: TokenEstimator = approximateTokenEstimator,
): {
  messages: ModelMessage[];
  omittedRunIds: RunId[];
  factsBlock?: ContextBlock;
  omissionBlock?: ContextBlock;
} {
  if (!view) return { messages: [], omittedRunIds: [] };
  const turns: Array<{ runId: RunId; messages: ModelMessage[]; facts: string }> = [];
  for (const runId of view.runOrder) {
    const run = view.runs[runId];
    if (!run || run.trigger !== "user" || (!run.input && !run.content?.length)) continue;
    const isCompleted = run.status === "completed";
    const isBudgetHandoff = run.status === "parked"
      && run.terminal?.reason === "budget"
      && run.steps[run.stepOrder.at(-1) ?? ""]?.finishReason === "handoff";
    const isInterrupted = (run.status === "failed" || run.status === "cancelled" || run.status === "parked")
      && !isBudgetHandoff;
    const hasImages = run.content?.some((part) => part.type === "image") === true;
    // Image attachments must remain visually continuous for follow-ups like "继续".
    const isInterruptedWithImages = isInterrupted && hasImages;
    const finalText = stripReservedRunFacts([...run.stepOrder]
      .reverse()
      .map((stepId) => run.steps[stepId]?.model?.text.trim())
      .find((text): text is string => Boolean(text)) ?? "");
    // Non-media interrupted Runs restore final assistant narrative only (ADR-0032).
    const isInterruptedNarrative = isInterrupted && !hasImages && Boolean(finalText);
    if (!isCompleted && !isBudgetHandoff && !isInterruptedWithImages && !isInterruptedNarrative) continue;
    const terminalSuffix = run.terminal?.reason ? ` (${run.terminal.reason})` : "";
    const narrative = isBudgetHandoff
      ? [
          "<qi-budget-handoff>",
          "The previous Run was paused for budget; it was not completed.",
          finalText || deterministicBudgetHandoff(view, runId),
          "</qi-budget-handoff>",
        ].join("\n")
      : isInterruptedWithImages
        ? [
            "<qi-interrupted-media-run>",
            `The previous Run ended as ${run.status}${terminalSuffix}; it was not completed.`,
            "The user's image attachment(s) from that Run are restored as visual context.",
            "Inspect those attached images directly; do not search mounts or the Workspace for the same screenshot unless the user asked for file discovery.",
            finalText || "No assistant reply was settled before interruption.",
            "</qi-interrupted-media-run>",
          ].join("\n")
        : isInterruptedNarrative
          ? [
              "<qi-interrupted-run>",
              `The previous Run ended as ${run.status}${terminalSuffix}; it was not completed.`,
              finalText,
              "</qi-interrupted-run>",
            ].join("\n")
          : finalText;
    if (!narrative) continue;
    turns.push({
      runId,
      facts: formatRunHistoryFacts(run),
      messages: [
        { role: "user", content: toModelInputParts(run.input ?? "", run.content, true) },
        { role: "assistant", content: [{ type: "text", text: narrative }] },
      ],
    });
  }

  const selected: Array<{ runId: RunId; messages: ModelMessage[]; facts: string }> = [];
  let usedTokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const turnTokens = estimateMessages(turn.messages, estimator);
    if (usedTokens + turnTokens > budgetTokens) break;
    selected.unshift(turn);
    usedTokens += turnTokens;
  }
  const selectedIds = new Set(selected.map((turn) => turn.runId));
  const omittedRunIds = turns.map((turn) => turn.runId).filter((runId) => !selectedIds.has(runId));
  const factsBlock = selected.length === 0
    ? undefined
    : {
        id: "history:write-settlement",
        kind: "recent" as const,
        source: "qi:runtime",
        role: "system" as const,
        content: [
          "Runtime-maintained write settlement summaries for restored conversation turns follow.",
          "They only state whether a write-effect Action settled; they do not identify what changed or verify completion.",
          "They are metadata, not assistant prose. Do not quote, reproduce, or invent them.",
          ...selected.map((turn, index) => `- restoredTurn=${index + 1}; ${turn.facts}`),
        ].join("\n"),
        priority: 1_000,
        required: true,
        retentionReason: "A coarse write settlement counters unsupported mutation narration without Runtime telemetry.",
      };
  const omissionBlock = omittedRunIds.length === 0
    ? undefined
    : createHistoryOmissionBlock(omittedRunIds.length);
  return {
    messages: selected.flatMap((turn) => turn.messages),
    omittedRunIds,
    ...(factsBlock ? { factsBlock } : {}),
    ...(omissionBlock ? { omissionBlock } : {}),
  };
}

function createHistoryOmissionBlock(olderTurnsOmitted: number): ContextBlock {
  return {
    id: "history:omission",
    kind: "recent",
    source: "qi:runtime",
    role: "system",
    content: [
      `Restored conversation history omitted olderTurnsOmitted=${olderTurnsOmitted} earlier user turn(s) under the history budget.`,
      "Those turns remain durable Session evidence. Prefer the restored messages already in this request for ordinary continue.",
      "Use qi_session_inspect with operation=recovery only when the prior Run terminal state or settlement is unclear.",
      "Do not invent Run IDs or tool transcripts for omitted turns.",
    ].join("\n"),
    priority: 999,
    required: false,
    retentionReason: "Optional bounded notice that earlier dialogue was truncated without Runtime IDs.",
  };
}

function createWorkPlanNavigationBlock(
  view: SessionView | undefined,
  mode: SessionMode,
): ContextBlock | undefined {
  if (mode !== "agent" || !view?.currentWorkPlanId) return undefined;
  const workPlanId = view.currentWorkPlanId;
  const plan = view.workPlans[workPlanId];
  const revision = plan?.revisions[plan.latestRevision];
  if (!revision) return undefined;
  const unfinished = revision.items.some((item) =>
    item.status === "pending" || item.status === "in_progress"
  );
  if (!unfinished) return undefined;
  const lines = revision.items.map((item) =>
    `- workItemId=${item.workItemId}; status=${item.status}; step=${item.step}`
  );
  return {
    id: "work-plan:current",
    kind: "recent",
    source: "qi:runtime",
    role: "system",
    content: [
      "Runtime-maintained Work Plan navigation snapshot for this Session.",
      "It is navigation only, not completion evidence. Continue with update_plan using these IDs; do not invent new ones.",
      `workPlanId=${workPlanId}; revision=${revision.revision}`,
      ...lines,
    ].join("\n"),
    priority: 980,
    required: false,
    retentionReason: "Unfinished Work Plan handles must remain available across consecutive Agent Runs.",
  };
}

function errorRef(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `diagnostic:inline:${encodeURIComponent(message).slice(0, 400)}`;
}

function resolveGoalBinding(
  view: SessionView | undefined,
  requested: RunGoalBinding | undefined,
): RunGoalBinding | undefined {
  if (requested) return { ...requested };
  return undefined;
}

function createGoalContextBlockForView(
  view: SessionView | undefined,
  goalId: GoalId,
): ReturnType<typeof createGoalContextBlock> | undefined {
  const goal = view?.goals[goalId];
  return goal ? createGoalContextBlock(goal) : undefined;
}

function consumeGoalTokens(input: {
  goalEngine?: GoalEngine;
  goalBinding?: RunGoalBinding;
  view?: SessionView;
  runId: RunId;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  reason: string;
}): boolean {
  if (!input.goalEngine || !input.goalBinding || !input.usage) return false;
  if (!input.view?.goals[input.goalBinding.goalId]?.resources.token) return false;
  const tokens = input.usage.inputTokens + input.usage.outputTokens;
  if (tokens <= 0) return false;
  const result = input.goalEngine.consumeResource(
    input.goalBinding.goalId,
    "token",
    tokens,
    input.reason,
    input.runId,
  );
  return result.exhausted;
}

function goalAttemptsAlreadyExhausted(view: SessionView | undefined, goalId: GoalId): boolean {
  const attempts = view?.goals[goalId]?.resources.attempts;
  return attempts !== undefined && attempts.consumed >= attempts.limit;
}

function stepHadNonReadEffect(
  view: SessionView | undefined,
  runId: RunId,
  stepId: StepId,
): boolean {
  return Object.values(view?.runs[runId]?.actions ?? {}).some(
    (action) => action.stepId === stepId && action.effect !== "read",
  );
}

/** Charge one Goal attempt after a Step that proposed a non-read Action. Returns true when exhausted. */
function consumeGoalAttemptForNonReadStep(input: {
  goalEngine?: GoalEngine;
  goalBinding?: RunGoalBinding;
  view?: SessionView;
  runId: RunId;
  stepId: StepId;
  stepNumber: number;
}): boolean {
  if (!input.goalEngine || !input.goalBinding || !input.view) return false;
  if (!input.view.goals[input.goalBinding.goalId]?.resources.attempts) return false;
  if (!stepHadNonReadEffect(input.view, input.runId, input.stepId)) return false;
  const result = input.goalEngine.consumeResource(
    input.goalBinding.goalId,
    "attempts",
    1,
    `Step ${input.stepNumber} non-read effect`,
    input.runId,
  );
  return result.exhausted;
}

function primaryGoalAssertionId(view: SessionView | undefined, goalId: GoalId): string | undefined {
  const goal = view?.goals[goalId];
  if (!goal) return undefined;
  return Object.values(goal.assertions).find((assertion) => assertion.required)?.assertionId
    ?? Object.values(goal.assertions)[0]?.assertionId;
}
