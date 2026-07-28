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
import { normalizeFunctionParameters } from "./openai-chat-completions.js";

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

  constructor(client: OpenAIResponsesClient, options: OpenAIResponsesModelPortOptions = {}) {
    this.#client = client;
    this.#providerNames = new Set(options.providerNames ?? ["openai"]);
    this.#contextTokens = options.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    this.#store = options.store ?? false;
    this.#requestMetadata = options.requestMetadata ?? true;
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
    return {
      input: new Set(["text", "image"]),
      output: new Set(["text", "reasoning", "action"]),
      contextTokens: this.#contextTokens,
      parallelActions: true,
      promptCache: true,
    };
  }

  async *stream(rawRequest: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const request = parseModelRequest(rawRequest);
    this.#assertProvider(request.model);
    throwIfAborted(signal);

    const body: ResponseCreateParamsStreaming = {
      model: request.model.model,
      input: toResponseInput(request.messages),
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

function toResponseInput(messages: readonly ModelMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    let pending: ResponseInputContent[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      if (message.role === "tool") {
        throw new TypeError("Tool messages may only contain tool-result parts");
      }
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
        case "image":
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
          input.push({
            type: "function_call_output",
            call_id: part.callId,
            output: encodeJson({ ok: !part.isError, output: part.output }),
          });
          break;
      }
    }
    flush();
  }
  return input;
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
