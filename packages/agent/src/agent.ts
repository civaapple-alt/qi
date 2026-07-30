import {
  InMemoryCapabilityBroker,
  type CapabilityBroker,
  type CapabilityLease,
} from "@civaapple/qi-agent/capability";
import type { ContextBlock } from "@civaapple/qi-ai/context";
import {
  InMemoryEventStore,
  type EventStore,
  type RunPlanBinding,
  type SessionMode,
  type SessionView,
} from "@civaapple/qi-agent/kernel";
import type { ModelPort, ModelRef } from "@civaapple/qi-ai";
import { TurnLoop, type RuntimeActivity, type TurnResult } from "@civaapple/qi-agent/loop";
import {
  createId,
  type RunId,
  type RunInputPart,
  type SessionEvent,
  type SessionId,
} from "@civaapple/qi-protocol";
import {
  ToolRegistry,
  type ArtifactStore,
  type RegistrationHandle,
  type ToolDefinition,
} from "@civaapple/qi-agent/tools";
import type { EffectJournal } from "@civaapple/qi-agent/effects";
import type { TSchema } from "@sinclair/typebox";
import { InMemoryArtifactStore } from "./memory-artifact-store.js";

export interface QiAgentOptions {
  readonly modelPort: ModelPort;
  readonly model: ModelRef;
  readonly subject?: string;
  readonly title?: string;
  readonly sessionId?: SessionId;
  readonly eventStore?: EventStore;
  readonly capabilityBroker?: CapabilityBroker;
  readonly toolRegistry?: ToolRegistry;
  readonly artifactStore?: ArtifactStore;
  readonly effectJournal?: EffectJournal;
  readonly workspaceRoot?: string;
  readonly contextBlocks?: readonly ContextBlock[];
  readonly contextBudgetTokens?: number;
  readonly outputReserveTokens?: number;
  readonly historyBudgetTokens?: number;
  readonly maxSteps?: number;
  readonly maxActionsPerStep?: number;
  readonly mode?: SessionMode;
  readonly onEvent?: (event: SessionEvent) => void;
  readonly onActivity?: (activity: RuntimeActivity) => void;
}

export interface QiPromptOptions {
  readonly title?: string;
  readonly model?: ModelRef;
  readonly contextBlocks?: readonly ContextBlock[];
  readonly contextBudgetTokens?: number;
  readonly maxOutputTokens?: number;
  readonly historyBudgetTokens?: number;
  readonly maxSteps?: number;
  readonly maxActionsPerStep?: number;
  readonly toolAllowlist?: readonly string[];
  readonly mode?: SessionMode;
  readonly planBinding?: RunPlanBinding;
  readonly existingRunId?: RunId;
  readonly workspaceRoot?: string;
  readonly signal?: AbortSignal;
}

export type QiAgentEventListener = (event: SessionEvent) => void;
export type QiAgentActivityListener = (activity: RuntimeActivity) => void;

/**
 * Small embedding façade over Qi's ordinary TurnLoop.
 *
 * It creates no capability lease. Registering a Tool makes its schema discoverable,
 * but execution still requires an explicit matching grant.
 */
export class QiAgent {
  readonly sessionId: SessionId;
  readonly eventStore: EventStore;
  readonly toolRegistry: ToolRegistry;
  readonly artifactStore: ArtifactStore;
  readonly capabilityBroker: CapabilityBroker | undefined;

  readonly #modelPort: ModelPort;
  readonly #model: ModelRef;
  readonly #subject: string;
  readonly #title: string | undefined;
  readonly #effectJournal: EffectJournal | undefined;
  readonly #workspaceRoot: string;
  readonly #contextBlocks: readonly ContextBlock[];
  readonly #contextBudgetTokens: number;
  readonly #maxOutputTokens: number;
  readonly #historyBudgetTokens: number;
  readonly #maxSteps: number;
  readonly #maxActionsPerStep: number;
  readonly #mode: SessionMode;
  readonly #loop: TurnLoop;
  readonly #eventListeners = new Set<QiAgentEventListener>();
  readonly #activityListeners = new Set<QiAgentActivityListener>();

  constructor(options: QiAgentOptions) {
    if (options.toolRegistry && options.capabilityBroker) {
      throw new TypeError(
        "Pass either toolRegistry or capabilityBroker, not both; an external registry's broker identity cannot be verified",
      );
    }
    this.sessionId = options.sessionId ?? (createId("ses") as SessionId);
    this.eventStore = options.eventStore ?? new InMemoryEventStore();
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
    this.#modelPort = options.modelPort;
    this.#model = structuredClone(options.model);
    this.#subject = options.subject ?? "main-agent";
    this.#title = options.title;
    this.#effectJournal = options.effectJournal;
    this.#workspaceRoot = options.workspaceRoot ?? ".";
    this.#contextBlocks = [...(options.contextBlocks ?? [])];
    this.#contextBudgetTokens = positiveInteger(
      options.contextBudgetTokens ?? 64_000,
      "contextBudgetTokens",
    );
    this.#maxOutputTokens = positiveInteger(
      options.outputReserveTokens ?? 8_000,
      "outputReserveTokens",
    );
    this.#historyBudgetTokens = nonNegativeInteger(
      options.historyBudgetTokens ?? 16_000,
      "historyBudgetTokens",
    );
    this.#maxSteps = positiveInteger(options.maxSteps ?? 12, "maxSteps");
    this.#maxActionsPerStep = positiveInteger(
      options.maxActionsPerStep ?? 6,
      "maxActionsPerStep",
    );
    this.#mode = options.mode ?? "agent";

    if (options.toolRegistry) {
      this.toolRegistry = options.toolRegistry;
      this.capabilityBroker = undefined;
    } else {
      const broker = options.capabilityBroker ?? new InMemoryCapabilityBroker();
      this.capabilityBroker = broker;
      this.toolRegistry = new ToolRegistry(broker);
    }

    this.#loop = new TurnLoop({
      eventStore: this.eventStore,
      modelPort: this.#modelPort,
      toolRegistry: this.toolRegistry,
      onEvent: (event) => {
        options.onEvent?.(event);
        for (const listener of this.#eventListeners) listener(event);
      },
      onActivity: (activity) => {
        options.onActivity?.(activity);
        for (const listener of this.#activityListeners) listener(activity);
      },
    });
  }

  get view(): SessionView | undefined {
    return this.eventStore.load(this.sessionId);
  }

  events(afterVersion = 0): readonly SessionEvent[] {
    return this.eventStore.read(this.sessionId, afterVersion).events;
  }

  subscribe(listener: QiAgentEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  subscribeActivity(listener: QiAgentActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  registerTool<Input extends TSchema, Output extends TSchema>(
    name: string,
    definition: ToolDefinition<Input, Output>,
  ): RegistrationHandle {
    return this.toolRegistry.register(name, definition);
  }

  /**
   * Convenience for the default InMemoryCapabilityBroker only.
   * Applications with a custom broker must use their own approval/grant workflow.
   */
  grant(lease: CapabilityLease): void {
    if (!(this.capabilityBroker instanceof InMemoryCapabilityBroker)) {
      throw new Error("grant() is available only with Qi's InMemoryCapabilityBroker");
    }
    this.capabilityBroker.grant(lease);
  }

  revoke(leaseId: string): boolean {
    if (!(this.capabilityBroker instanceof InMemoryCapabilityBroker)) {
      throw new Error("revoke() is available only with Qi's InMemoryCapabilityBroker");
    }
    return this.capabilityBroker.revoke(leaseId);
  }

  steer(message: string, actorId = "user"): void {
    this.#loop.steer(this.sessionId, message, actorId);
  }

  async prompt(input: string, options?: QiPromptOptions): Promise<TurnResult>;
  async prompt(content: readonly RunInputPart[], options?: QiPromptOptions): Promise<TurnResult>;
  async prompt(
    inputOrContent: string | readonly RunInputPart[],
    options: QiPromptOptions = {},
  ): Promise<TurnResult> {
    const content = typeof inputOrContent === "string"
      ? undefined
      : structuredClone([...inputOrContent]);
    let imageNumber = 0;
    const input = typeof inputOrContent === "string"
      ? inputOrContent
      : inputOrContent.map((part) =>
          part.type === "text"
            ? part.text
            : `[image #${++imageNumber} (${part.width}×${part.height})]`
        ).join("");
    if (!input.trim() && options.existingRunId === undefined) {
      throw new TypeError("prompt input must not be empty");
    }
    const contextBudgetTokens = positiveInteger(
      options.contextBudgetTokens ?? this.#contextBudgetTokens,
      "contextBudgetTokens",
    );
    const maxOutputTokens = positiveInteger(
      options.maxOutputTokens ?? this.#maxOutputTokens,
      "maxOutputTokens",
    );
    if (maxOutputTokens >= contextBudgetTokens) {
      throw new RangeError("maxOutputTokens must be smaller than contextBudgetTokens");
    }
    const title = options.title ?? this.#title;

    return this.#loop.run({
      sessionId: this.sessionId,
      ...(title === undefined ? {} : { title }),
      subject: this.#subject,
      input,
      ...(content === undefined ? {} : { content }),
      model: structuredClone(options.model ?? this.#model),
      contextBlocks: [...this.#contextBlocks, ...(options.contextBlocks ?? [])],
      contextBudgetTokens,
      maxOutputTokens,
      historyBudgetTokens: nonNegativeInteger(
        options.historyBudgetTokens ?? this.#historyBudgetTokens,
        "historyBudgetTokens",
      ),
      maxSteps: positiveInteger(options.maxSteps ?? this.#maxSteps, "maxSteps"),
      maxActionsPerStep: positiveInteger(
        options.maxActionsPerStep ?? this.#maxActionsPerStep,
        "maxActionsPerStep",
      ),
      ...(options.toolAllowlist === undefined
        ? {}
        : { toolAllowlist: [...options.toolAllowlist] }),
      mode: options.mode ?? this.#mode,
      ...(options.planBinding === undefined ? {} : { planBinding: options.planBinding }),
      ...(options.existingRunId === undefined ? {} : { existingRunId: options.existingRunId }),
      workspaceRoot: options.workspaceRoot ?? this.#workspaceRoot,
      artifactStore: this.artifactStore,
      ...(this.#effectJournal === undefined ? {} : { effectJournal: this.#effectJournal }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}
