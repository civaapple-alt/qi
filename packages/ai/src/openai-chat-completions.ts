import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
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
import {
  assertProfileSupportsRequest,
  modelCapabilitiesFromProfile,
  requireProviderProfile,
  type ProviderProfile,
} from "./provider-profile.js";

export interface OpenAIChatCompletionsClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): PromiseLike<AsyncIterable<ChatCompletionChunk>> | AsyncIterable<ChatCompletionChunk>;
    };
  };
}

export interface OpenAIChatCompletionsModelPortOptions {
  providerNames?: readonly string[];
  contextTokens?: number;
  profile?: ProviderProfile;
}

/**
 * Stateless adapter from Qi's portable ModelPort to OpenAI-compatible Chat Completions.
 * Tool-call argument fragments are released only after a terminal finish reason.
 */
export class OpenAIChatCompletionsModelPort implements ModelPort {
  readonly #client: OpenAIChatCompletionsClient;
  readonly #providerNames: ReadonlySet<string>;
  readonly #contextTokens: number;
  readonly #profile: ProviderProfile | undefined;

  constructor(client: OpenAIChatCompletionsClient, options: OpenAIChatCompletionsModelPortOptions = {}) {
    this.#client = client;
    this.#providerNames = new Set(options.providerNames ?? ["openai"]);
    this.#contextTokens = options.contextTokens ?? options.profile?.contextTokens ?? 128_000;
    this.#profile = options.profile;
    if (this.#providerNames.size === 0) throw new TypeError("At least one provider name is required");
    if (!Number.isInteger(this.#contextTokens) || this.#contextTokens <= 0) {
      throw new RangeError("contextTokens must be a positive integer");
    }
  }

  static fromClientOptions(
    clientOptions: ClientOptions = {},
    options: OpenAIChatCompletionsModelPortOptions = {},
  ): OpenAIChatCompletionsModelPort {
    return new OpenAIChatCompletionsModelPort(new OpenAI(clientOptions), options);
  }

  async capabilities(model: ModelRef): Promise<ModelCapabilities> {
    this.#assertProvider(model);
    if (this.#profile) {
      return modelCapabilitiesFromProfile(this.#profile, { contextTokens: this.#contextTokens });
    }
    return {
      input: new Set(["text"]),
      output: new Set(["text", "action"]),
      contextTokens: this.#contextTokens,
      parallelActions: true,
      promptCache: false,
    };
  }

  async *stream(rawRequest: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const request = parseModelRequest(rawRequest);
    this.#assertProvider(request.model);
    const profile = this.#profile ?? tryProfile(request.model.provider);
    if (profile) {
      assertProfileSupportsRequest(profile, { toolCount: request.tools.length });
    }
    throwIfAborted(signal);

    const body: ChatCompletionCreateParamsStreaming = {
      model: request.model.model,
      messages: toChatMessages(request.messages),
      tools: request.tools.map(toChatTool),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    };

    const stream = await this.#client.chat.completions.create(
      body,
      signal === undefined ? undefined : { signal },
    );

    const toolBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
    let sawContent = false;

    for await (const chunk of stream) {
      throwIfAborted(signal);
      const choice = chunk.choices[0];
      if (chunk.usage) {
        const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
          .prompt_tokens_details?.cached_tokens;
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        };
      }
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        sawContent = true;
        yield parseModelEvent({ type: "text.delta", delta: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          const current = toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof call.id === "string" && call.id.length > 0) current.id = call.id;
          if (typeof call.function?.name === "string" && call.function.name.length > 0) {
            current.name = call.function.name;
          }
          if (typeof call.function?.arguments === "string") {
            current.arguments += call.function.arguments;
          }
          toolBuffers.set(index, current);
        }
      }
    }

    if (usage && (profile?.capabilities.usage ?? true)) {
      yield parseModelEvent({
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
      });
    }

    if (finishReason === "length") {
      yield parseModelEvent({ type: "completed", finishReason: "length" });
      return;
    }

    if (finishReason === "tool_calls" || toolBuffers.size > 0) {
      const ordered = [...toolBuffers.entries()].sort((left, right) => left[0] - right[0]);
      for (const [, buffered] of ordered) {
        if (!buffered.id || !buffered.name) {
          yield parseModelEvent({
            type: "failed",
            code: "incomplete_tool_call",
            message: "Chat Completions stream ended with an incomplete tool call",
            retryable: false,
          });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffered.arguments || "{}") as unknown;
        } catch (error) {
          yield parseModelEvent({
            type: "failed",
            code: "invalid_tool_arguments",
            message: `Invalid JSON arguments for ${buffered.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            retryable: false,
          });
          return;
        }
        yield parseModelEvent({
          type: "action.requested",
          callId: buffered.id,
          name: buffered.name,
          input: parsed,
        });
      }
      yield parseModelEvent({ type: "completed", finishReason: "actions" });
      return;
    }

    if (finishReason === "stop" || finishReason === null) {
      if (!sawContent && toolBuffers.size === 0 && finishReason === null) {
        yield parseModelEvent({
          type: "failed",
          code: "incomplete_stream",
          message: "Chat Completions stream ended without a terminal finish reason",
          retryable: true,
        });
        return;
      }
      yield parseModelEvent({ type: "completed", finishReason: "stop" });
      return;
    }

    yield parseModelEvent({
      type: "failed",
      code: "unsupported_finish_reason",
      message: `Unsupported Chat Completions finish reason: ${finishReason}`,
      retryable: false,
    });
  }

  #assertProvider(model: ModelRef): void {
    if (!this.#providerNames.has(model.provider)) {
      throw new TypeError(`Chat Completions adapter does not serve provider ${model.provider}`);
    }
  }
}

function tryProfile(id: string): ProviderProfile | undefined {
  try {
    return requireProviderProfile(id);
  } catch {
    return undefined;
  }
}

function toChatTool(tool: ModelRequest["tools"][number]): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeFunctionParameters(tool.inputSchema),
    },
  };
}

/**
 * DeepSeek (and other strict OpenAI-compat hosts) require `parameters.type === "object"`.
 * TypeBox `Type.Union([...objects])` compiles to bare `anyOf` without a top-level type.
 */
export function normalizeFunctionParameters(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...schema };
  if (copy.type === "object") return copy;
  if (Array.isArray(copy.anyOf) || Array.isArray(copy.oneOf)) {
    return { ...copy, type: "object" };
  }
  if (copy.type === undefined || copy.type === null) {
    return {
      properties: isPlainObject(copy.properties) ? copy.properties as Record<string, unknown> : {},
      additionalProperties: copy.additionalProperties === false ? false : true,
      ...omitType(copy),
      type: "object",
    };
  }
  // Non-object root schemas are not valid function parameters for these hosts.
  return {
    type: "object",
    properties: {
      value: copy,
    },
    required: ["value"],
    additionalProperties: false,
  };
}

function omitType(schema: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, ...rest } = schema;
  return rest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toChatMessages(messages: readonly ModelMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        result.push({ role: "system", content: textOnly(message, "system") });
        break;
      case "user":
        result.push({ role: "user", content: textOnly(message, "user") });
        break;
      case "assistant": {
        const toolCalls = message.content.filter((part) => part.type === "tool-call");
        const text = message.content
          .filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (toolCalls.length > 0) {
          result.push({
            role: "assistant",
            ...(text ? { content: text } : { content: null }),
            tool_calls: toolCalls.map((part) => {
              if (part.type !== "tool-call") throw new TypeError("expected tool-call");
              return {
                id: part.callId,
                type: "function" as const,
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input ?? {}),
                },
              };
            }),
          });
        } else {
          result.push({ role: "assistant", content: text });
        }
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") {
            throw new TypeError("Tool messages may only contain tool-result parts");
          }
          result.push({
            role: "tool",
            tool_call_id: part.callId,
            content: JSON.stringify({ ok: !part.isError, output: part.output }),
          });
        }
        break;
    }
  }
  return result;
}

function textOnly(message: ModelMessage, role: string): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "image" || part.type === "artifact") {
      throw new TypeError(`Chat Completions adapter does not accept ${part.type} parts on ${role} messages`);
    } else {
      throw new TypeError(`${role} messages cannot contain ${part.type} parts`);
    }
  }
  return parts.join("");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The model request was aborted", "AbortError");
}
