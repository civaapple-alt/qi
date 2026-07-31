import OpenAI, { type ClientOptions } from "openai";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  parseModelEvent,
  parseModelRequest,
  type ModelCapabilities,
  type ModelContentPart,
  type ModelEvent,
  type ModelMessage,
  type ModelPort,
  type ModelRef,
  type ModelRequest,
} from "./model.js";
import { normalizeFunctionParameters, normalizeReasoningEffort } from "./openai-chat-completions.js";
import {
  getProviderModelProfile,
  type ProviderProfile,
  type ProviderThinkingEffort,
} from "./provider-profile.js";

export interface OpenAIResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<AsyncIterable<ResponseStreamEvent>> | AsyncIterable<ResponseStreamEvent>;
  };
}

export interface OpenAIResponsesModelPortOptions {
  /** Provider aliases accepted in ModelRef. */
  providerNames?: readonly string[];
  /** Conservative advertised window used by the context planner. */
  contextTokens?: number;
  /** Defaults to false so the local EventStore remains the source of truth. */
  store?: boolean;
  /** Send portable request metadata to providers that support the Responses metadata field. */
  requestMetadata?: boolean;
  /** When false, image parts are rejected at the adapter boundary. Defaults to true. */
  imageInput?: boolean;
  /** Operator-selected thinking effort; resolved against the model profile when present. */
  reasoningEffort?: string | null;
  /** Optional profile for per-model thinking defaults. */
  profile?: ProviderProfile;
}

const DEFAULT_CONTEXT_TOKENS = 128_000;

/**
 * Stateless adapter from Qi's portable ModelPort to the OpenAI Responses API.
 * Every turn sends the complete portable conversation; no provider conversation ID
 * becomes durable application state.
 */
export class OpenAIResponsesModelPort implements ModelPort {
  readonly #client: OpenAIResponsesClient;
  readonly #providerNames: ReadonlySet<string>;
  readonly #contextTokens: number;
  readonly #store: boolean;
  readonly #requestMetadata: boolean;
  readonly #imageInput: boolean;
  readonly #reasoningEffort: string | null | undefined;
  readonly #profile: ProviderProfile | undefined;

  constructor(client: OpenAIResponsesClient, options: OpenAIResponsesModelPortOptions = {}) {
    this.#client = client;
    this.#providerNames = new Set(options.providerNames ?? ["openai"]);
    this.#contextTokens = options.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    this.#store = options.store ?? false;
    this.#requestMetadata = options.requestMetadata ?? true;
    this.#imageInput = options.imageInput ?? true;
    this.#reasoningEffort = options.reasoningEffort;
    this.#profile = options.profile;
    if (this.#providerNames.size === 0) throw new TypeError("At least one provider name is required");
    if (!Number.isInteger(this.#contextTokens) || this.#contextTokens <= 0) {
      throw new RangeError("contextTokens must be a positive integer");
    }
  }

  static fromClientOptions(
    clientOptions: ClientOptions = {},
    options: OpenAIResponsesModelPortOptions = {},
  ): OpenAIResponsesModelPort {
    return new OpenAIResponsesModelPort(new OpenAI(clientOptions), options);
  }

  async capabilities(model: ModelRef): Promise<ModelCapabilities> {
    this.#assertProvider(model);
    const input = new Set<"text" | "image" | "artifact">(["text"]);
    if (this.#imageInput) input.add("image");
    const output = new Set<"text" | "reasoning" | "action">(["text", "action"]);
    if (this.#profile === undefined || this.#profile.capabilities.reasoning) {
      output.add("reasoning");
    }
    return {
      input,
      output,
      contextTokens: this.#contextTokens,
      parallelActions: true,
      promptCache: true,
    };
  }

  async *stream(rawRequest: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const request = parseModelRequest(rawRequest);
    this.#assertProvider(request.model);
    throwIfAborted(signal);

    const reasoning = responsesReasoningConfig(
      this.#profile,
      request.model.model,
      this.#reasoningEffort,
    );
    const body: ResponseCreateParamsStreaming & {
      reasoning?: { effort: ProviderThinkingEffort | "none" | "minimal" | "medium" | "xhigh" };
    } = {
      model: request.model.model,
      input: toResponseInput(request.messages, { imageInput: this.#imageInput }),
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: normalizeFunctionParameters(tool.inputSchema as Record<string, unknown>),
        strict: false,
      })),
      stream: true,
      store: this.#store,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: request.maxOutputTokens }),
      ...(!this.#requestMetadata || request.metadata === undefined
        ? {}
        : { metadata: request.metadata }),
      ...(reasoning === undefined ? {} : { reasoning }),
    };

    const stream = await this.#client.responses.create(
      body,
      signal === undefined ? undefined : { signal },
    );

    for await (const event of stream) {
      throwIfAborted(signal);
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield parseModelEvent({ type: "text.delta", delta: event.delta });
          break;
        case "response.refusal.delta":
          if (event.delta) yield parseModelEvent({ type: "text.delta", delta: event.delta });
          break;
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta":
          if (event.delta) yield parseModelEvent({ type: "reasoning.delta", delta: event.delta });
          break;
        case "response.completed": {
          const completion = completedEvents(event.response);
          for (const mapped of completion) yield parseModelEvent(mapped);
          return;
        }
        case "response.incomplete":
          if (event.response.usage) yield parseModelEvent(toUsageEvent(event.response));
          yield parseModelEvent({
            type: "completed",
            finishReason: "length",
            responseId: event.response.id,
          });
          return;
        case "response.failed":
          yield parseModelEvent({
            type: "failed",
            code: event.response.error?.code ?? "response_failed",
            message: event.response.error?.message ?? "Responses API request failed",
            retryable: isRetryableCode(event.response.error?.code),
          });
          return;
        case "error":
          yield parseModelEvent({
            type: "failed",
            code: event.code ?? "stream_error",
            message: event.message,
            retryable: isRetryableCode(event.code),
          });
          return;
        default:
          break;
      }
    }

    throw new Error("Responses API stream ended without a terminal event");
  }

  #assertProvider(model: ModelRef): void {
    if (!this.#providerNames.has(model.provider)) {
      throw new TypeError(`Responses adapter does not serve provider ${model.provider}`);
    }
  }
}

function responsesReasoningConfig(
  profile: ProviderProfile | undefined,
  model: string,
  requestedEffort: string | null | undefined,
): { effort: ProviderThinkingEffort | "none" } | undefined {
  if (profile === undefined) {
    const effort = normalizeReasoningEffort(requestedEffort);
    return effort === undefined ? undefined : { effort };
  }
  const modelProfile = getProviderModelProfile(profile, model);
  if (!modelProfile?.thinking && requestedEffort === undefined) return undefined;
  const effort = normalizeReasoningEffort(requestedEffort);
  if (effort === "none") return { effort: "none" };
  if (!modelProfile?.thinking) {
    return effort === undefined ? undefined : { effort };
  }
  if (modelProfile.thinking.mode === "toggle") {
    return { effort: "high" };
  }
  const supported = modelProfile.thinking.supportedEfforts;
  const selected = effort !== undefined && supported?.includes(effort)
    ? effort
    : modelProfile.thinking.defaultEffort ?? supported?.[0] ?? "high";
  return { effort: selected };
}

function toResponseInput(
  messages: readonly ModelMessage[],
  options: { imageInput: boolean },
): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  // Keep function_call_output items contiguous for a parallel tool batch; defer synthetic
  // user media messages until that batch ends (same contract as Chat Completions).
  const pendingToolMedia: ResponseInputItem[] = [];
  const flushToolMedia = (): void => {
    if (pendingToolMedia.length === 0) return;
    input.push(...pendingToolMedia);
    pendingToolMedia.length = 0;
  };

  for (const message of messages) {
    let pending: ResponseInputContent[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      if (message.role === "tool") {
        throw new TypeError("Tool messages may only contain tool-result parts");
      }
      flushToolMedia();
      input.push({
        type: "message",
        role: message.role,
        content: pending,
      });
      pending = [];
    };

    for (const part of message.content) {
      switch (part.type) {
        case "text":
          pending.push({ type: "input_text", text: part.text });
          break;
        case "reasoning":
          flush();
          if (message.role !== "assistant") {
            throw new TypeError("reasoning parts must belong to an assistant message");
          }
          flushToolMedia();
          input.push({
            type: "reasoning",
            content: [{ type: "reasoning_text", text: part.text }],
          } as ResponseInputItem);
          break;
        case "image":
          if (!options.imageInput) {
            throw new TypeError("This Responses provider profile does not accept image input");
          }
          assertSupportedImageUri(part);
          pending.push({ type: "input_image", image_url: part.uri, detail: "auto" });
          break;
        case "artifact":
          throw new TypeError(
            `Artifact ${part.ref} must be resolved before invoking the OpenAI adapter`,
          );
        case "tool-call":
          flush();
          if (message.role !== "assistant") {
            throw new TypeError("tool-call parts must belong to an assistant message");
          }
          input.push({
            type: "function_call",
            call_id: part.callId,
            name: part.name,
            arguments: encodeJson(part.input),
          });
          break;
        case "tool-result":
          flush();
          if (message.role !== "tool") {
            throw new TypeError("tool-result parts must belong to a tool message");
          }
          const { output, images } = splitToolResultOutput(part.output);
          input.push({
            type: "function_call_output",
            call_id: part.callId,
            output: encodeJson({ ok: !part.isError, output }),
          });
          if (images.length > 0) {
            if (!options.imageInput) {
              throw new TypeError("This Responses provider profile does not accept image input");
            }
            pendingToolMedia.push({
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: `Attached media from tool result ${part.callId}:` },
                ...images.map((image) => {
                  assertSupportedImageUri(image);
                  return { type: "input_image" as const, image_url: image.uri, detail: "auto" as const };
                }),
              ],
            });
          }
          break;
      }
    }
    flush();
  }
  flushToolMedia();
  return input;
}

function splitToolResultOutput(output: unknown): {
  output: unknown;
  images: Array<Extract<ModelContentPart, { type: "image" }>>;
} {
  if (!Array.isArray(output)) return { output, images: [] };
  const images: Array<Extract<ModelContentPart, { type: "image" }>> = [];
  const retained: unknown[] = [];
  for (const item of output) {
    if (isModelImagePart(item)) images.push(item);
    else if (isArtifactPart(item)) {
      throw new TypeError(`Artifact ${item.ref} must be resolved before invoking the OpenAI adapter`);
    } else retained.push(item);
  }
  return { output: retained, images };
}

function isModelImagePart(value: unknown): value is Extract<ModelContentPart, { type: "image" }> {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { uri?: unknown }).uri === "string" &&
    typeof (value as { mediaType?: unknown }).mediaType === "string";
}

function isArtifactPart(value: unknown): value is Extract<ModelContentPart, { type: "artifact" }> {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "artifact" &&
    typeof (value as { ref?: unknown }).ref === "string";
}

function completedEvents(response: Response): ModelEvent[] {
  const actions: ModelEvent[] = [];
  for (const item of response.output) {
    if (item.type !== "function_call") continue;
    actions.push(toActionEvent(item));
  }
  return [
    ...(response.usage ? [toUsageEvent(response)] : []),
    ...actions,
    {
      type: "completed",
      finishReason: actions.length > 0 ? "actions" : "stop",
      responseId: response.id,
    },
  ];
}

function toActionEvent(item: ResponseFunctionToolCall): ModelEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.arguments) as unknown;
  } catch (error) {
    throw new TypeError(
      `OpenAI returned invalid JSON arguments for ${item.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { type: "action.requested", callId: item.call_id, name: item.name, input: parsed };
}

function toUsageEvent(response: Response): ModelEvent {
  const usage = response.usage;
  if (!usage) throw new TypeError("Response has no usage information");
  return {
    type: "usage",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
  };
}

function assertSupportedImageUri(part: Extract<ModelContentPart, { type: "image" }>): void {
  if (/^(https?:|data:)/i.test(part.uri)) return;
  throw new TypeError(
    `OpenAI image input requires an http(s) URL or data URL; received ${part.uri}`,
  );
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value cannot be represented as JSON");
  return encoded;
}

function isRetryableCode(code: string | null | undefined): boolean {
  return code === "server_error" || code === "rate_limit_exceeded" || code === "temporarily_unavailable";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The model request was aborted", "AbortError");
}
