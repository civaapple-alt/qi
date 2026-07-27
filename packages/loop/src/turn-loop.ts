import { randomUUID } from "node:crypto";
import {
  mergeRedactionSummaries,
  redactSensitiveText,
  redactSensitiveValue,
  type RedactionSummary,
} from "@civaapple/qi-capability";
import {
  ContextBudgetError,
  approximateTokenEstimator,
  compileContext,
  type ContextBlock,
} from "@civaapple/qi-context";
import type { EventStore, RunPlanBinding, SessionMode, SessionView } from "@civaapple/qi-kernel";
import type { ModelContentPart, ModelEvent, ModelMessage, ModelPort, ModelRef } from "@civaapple/qi-llm";
import { createId, type RunId, type SessionEvent, type SessionId, type StepId } from "@civaapple/qi-protocol";
import {
  AuthorityDeniedError,
  ToolFailure,
  ToolInputError,
  type ArtifactStore,
  type InspectedToolCall,
  type ToolExecutionContext,
  type ToolRegistry,
} from "@civaapple/qi-tools";
import type { EffectJournal } from "@civaapple/qi-workspace";
import { EventWriter } from "./event-writer.js";
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
  model: ModelRef;
  contextBlocks: readonly ContextBlock[];
  contextBudgetTokens: number;
  maxOutputTokens?: number;
  historyBudgetTokens?: number;
  maxSteps: number;
  maxActionsPerStep?: number;
  /** When set, only these tool names are advertised to the model for this Turn. */
  toolAllowlist?: readonly string[];
  /** Session mode frozen onto run.triggered when creating a new Run. */
  mode?: SessionMode;
  planBinding?: RunPlanBinding;
  /** Execute a Run that was already durably triggered (Plan accept / next-run answer). */
  existingRunId?: RunId;
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  effectJournal?: EffectJournal;
  signal?: AbortSignal;
  /** Live read-only mounts; called when building each Action context. */
  getMounts?: () => readonly import("@civaapple/qi-tools").WorkspaceMount[];
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
    const historyBudgetTokens = request.historyBudgetTokens
      ?? Math.min(16_000, Math.floor(request.contextBudgetTokens / 4));
    if (!Number.isInteger(historyBudgetTokens) || historyBudgetTokens < 0) {
      throw new RangeError("historyBudgetTokens must be a non-negative integer");
    }
    const writer = new EventWriter(this.#eventStore, request.sessionId, this.#clock, this.#onEvent);
    const history = compileConversationHistory(
      writer.view,
      Math.min(historyBudgetTokens, request.contextBudgetTokens),
    );
    const historyConversation = history.messages;
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
    if (request.existingRunId) {
      const existing = writer.view?.runs[request.existingRunId];
      if (!existing || existing.status !== "triggered") {
        throw new Error(`existingRunId ${request.existingRunId} is not in triggered status`);
      }
      runId = request.existingRunId;
      runInput = existing.input ?? request.input;
    } else {
      runId = createId("run") as RunId;
      writer.append(
        "run.triggered",
        {
          runId,
          trigger: "user",
          input: request.input,
          mode: runMode,
          ...(request.planBinding === undefined ? {} : { planBinding: request.planBinding }),
        },
        { kind: "user", id: request.subject },
      );
    }
    writer.append("run.started", { runId }, { kind: "runtime", id: "qi" });
    const frozenMode = writer.view?.runs[runId]?.mode ?? runMode;

    const conversation: ModelMessage[] = [
      ...historyConversation,
      { role: "user", content: [{ type: "text", text: runInput }] },
    ];
    const settledExchanges: SettledActionExchange[] = [];
    let finalText = "";

    for (let stepNumber = 1; stepNumber <= request.maxSteps; stepNumber += 1) {
      const stepId = createId("stp") as StepId;
      writer.append("step.started", { runId, stepId }, { kind: "runtime", id: "qi" });
      const registeredNames = this.#toolRegistry.catalog().map((tool) => tool.name);
      const modeTools = toolsForMode(frozenMode, registeredNames);
      const allowlist = request.toolAllowlist
        ? modeTools.filter((name) => request.toolAllowlist!.includes(name))
        : modeTools;
      const catalog = this.#toolRegistry.catalog({ tools: allowlist });
      const toolCatalogTokens = approximateTokenEstimator.estimate(
        JSON.stringify(catalog.map((tool) => tool.model)),
      );

      let compiled;
      try {
        const pressureThreshold = Math.floor(request.contextBudgetTokens * contextPressureRatio);
        if (estimateMessages(conversation) + toolCatalogTokens > pressureThreshold) {
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
          compiled = compileTurnContext(request, conversation, toolCatalogTokens);
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
          compiled = compileTurnContext(request, conversation, toolCatalogTokens);
        }
        const conversationTokens = estimateMessages(conversation);
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
            estimatedTokens: compiled.estimatedTokens + conversationTokens + toolCatalogTokens,
            budgetTokens: request.contextBudgetTokens,
          },
          { kind: "runtime", id: "context_compiler" },
        );
      } catch (error) {
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
        modelResult = await aggregateModelEvents(
          this.#modelPort.stream(
            {
              requestId,
              model: request.model,
              messages: modelInput.value,
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
        );
      } catch (error) {
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
      modelResult.text = safeText.value;
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
      finalText = modelResult.text;

      if (modelResult.actions.length === 0) {
        writer.append(
          "step.completed",
          { runId, stepId, finishReason: completedTerminal.finishReason === "length" ? "error" : "response" },
          { kind: "runtime", id: "qi" },
        );
        if (completedTerminal.finishReason === "length") {
          writer.append(
            "run.parked",
            { runId, reason: "budget", detail: "Model output reached its length boundary" },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
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
        for (const candidate of candidates) {
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
        }
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

      const writtenResources = new Set<string>();
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        if (!candidate) throw new Error(`Missing candidate at index ${candidateIndex}`);
        writer.append(
          "authority.requested",
          { runId, stepId, actionId: candidate.actionId },
          { kind: "runtime", id: "capability_broker" },
        );
        let authorized;
        try {
          authorized = await candidate.inspected.authorize();
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
          continue;
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
          if (candidate.inspected.effect !== "read") {
            const overlap = candidate.inspected.resources.filter((resource) => writtenResources.has(resource));
            if (overlap.length > 0) {
              throw new ToolFailure(
                "BATCH_WRITE_CONFLICT",
                `A prior write in this step already changed ${overlap.join(", ")}; re-read that path, then edit with the new expectedSha256`,
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
          if (candidate.inspected.effect !== "read") {
            for (const resource of candidate.inspected.resources) writtenResources.add(resource);
          }
          toolResults.set(candidate.callId, {
            type: "tool-result",
            callId: candidate.callId,
            output: settlement.modelOutput,
            isError: false,
          });
        } catch (error) {
          if (request.signal?.aborted) {
            writer.append(
              "action.cancelled",
              { runId, stepId, actionId: candidate.actionId, reason: "Tool call cancelled" },
              { kind: "runtime", id: "tool_runner" },
            );
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
            return this.#result(writer, request.sessionId, runId, "cancelled", finalText);
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
            toolResults.set(candidate.callId, {
              type: "tool-result",
              callId: candidate.callId,
              output: modelOutput,
              isError: true,
            });
            continue;
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
          this.#denyUnstartedCandidates(
            writer,
            runId,
            stepId,
            candidates.slice(candidateIndex + 1),
            "Batch stopped because a prior action has an indeterminate effect",
          );
          writer.append(
            "run.parked",
            { runId, reason: "indeterminate-effect", detail: "Tool settlement could not be confirmed" },
            { kind: "runtime", id: "qi" },
          );
          return this.#result(writer, request.sessionId, runId, "parked", finalText);
        }
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
    const view = writer.view;
    if (!view) throw new Error("TurnLoop ended without a Session view");
    return { sessionId, runId, status, text, view };
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
      if (estimateMessages(input.conversation) <= input.targetTokens) break;
      if (exchange.compacted || (!exchange.consumed && !input.includeUnconsumed)) continue;
      const originalEstimatedTokens = estimateMessages(exchange.messages);
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
      const compactedEstimatedTokens = estimateMessages([previewMessage]);
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
        onText?.(redactSensitiveText(text).value.slice(-16_000));
        break;
      case "reasoning.delta":
        reasoning += event.delta;
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
  const candidate = output as { ref?: unknown; diffRef?: unknown };
  const ref = candidate.ref ?? candidate.diffRef;
  return typeof ref === "string" ? ref : undefined;
}

function compileTurnContext(
  request: TurnRequest,
  conversation: readonly ModelMessage[],
  toolCatalogTokens: number,
) {
  const fixedTokens = estimateMessages(conversation) + toolCatalogTokens;
  const remaining = request.contextBudgetTokens - fixedTokens;
  if (remaining <= 0) throw new ContextBudgetError(fixedTokens, request.contextBudgetTokens);
  return compileContext({
    blocks: request.contextBlocks,
    budgetTokens: remaining,
  });
}

function estimateMessages(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + approximateTokenEstimator.estimate(JSON.stringify(message)),
    0,
  );
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

function compileConversationHistory(
  view: SessionView | undefined,
  budgetTokens: number,
): { messages: ModelMessage[]; omittedRunIds: RunId[] } {
  if (!view) return { messages: [], omittedRunIds: [] };
  const turns: Array<{ runId: RunId; messages: ModelMessage[] }> = [];
  for (const runId of view.runOrder) {
    const run = view.runs[runId];
    if (!run || run.trigger !== "user" || run.status !== "completed" || !run.input) continue;
    const finalText = [...run.stepOrder]
      .reverse()
      .map((stepId) => run.steps[stepId]?.model?.text.trim())
      .find((text): text is string => Boolean(text));
    if (!finalText) continue;
    turns.push({
      runId,
      messages: [
        { role: "user", content: [{ type: "text", text: run.input }] },
        { role: "assistant", content: [{ type: "text", text: finalText }] },
      ],
    });
  }

  const selected: Array<{ runId: RunId; messages: ModelMessage[] }> = [];
  let usedTokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const turnTokens = turn.messages.reduce(
      (total, message) => total + approximateTokenEstimator.estimate(JSON.stringify(message)),
      0,
    );
    if (usedTokens + turnTokens > budgetTokens) break;
    selected.unshift(turn);
    usedTokens += turnTokens;
  }
  const selectedIds = new Set(selected.map((turn) => turn.runId));
  return {
    messages: selected.flatMap((turn) => turn.messages),
    omittedRunIds: turns.map((turn) => turn.runId).filter((runId) => !selectedIds.has(runId)),
  };
}

function errorRef(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `diagnostic:inline:${encodeURIComponent(message).slice(0, 400)}`;
}
