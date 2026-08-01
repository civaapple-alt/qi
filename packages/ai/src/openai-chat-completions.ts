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
  getProviderModelProfile,
  modelCapabilitiesFromProfile,
  requireProviderProfile,
  type ProviderThinkingEffort,
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
  reasoningEffort?: string | null;
  /** Explicit opt-in for custom OpenAI-compatible endpoints. Official profiles declare this themselves. */
  imageInput?: boolean;
}

/**
 * Stateless adapter from Qi's portable ModelPort to OpenAI-compatible Chat Completions.
 * Tool-call argument fragments are released only after a terminal finish reason.
 */
export class OpenAIChatCompletionsModelPort implements ModelPort {
  readonly #client: OpenAIChatCompletionsClient;
  readonly #providerNames: ReadonlySet<string>;
  readonly #contextTokens: number | undefined;
  readonly #profile: ProviderProfile | undefined;
  readonly #reasoningEffort: string | null | undefined;
  readonly #imageInput: boolean | undefined;

  constructor(client: OpenAIChatCompletionsClient, options: OpenAIChatCompletionsModelPortOptions = {}) {
    this.#client = client;
    this.#providerNames = new Set(options.providerNames ?? ["openai"]);
    this.#contextTokens = options.contextTokens;
    this.#profile = options.profile;
    this.#reasoningEffort = options.reasoningEffort;
    this.#imageInput = options.imageInput;
    if (this.#providerNames.size === 0) throw new TypeError("At least one provider name is required");
    if (
      this.#contextTokens !== undefined &&
      (!Number.isInteger(this.#contextTokens) || this.#contextTokens <= 0)
    ) {
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
    const profile = this.#profile ?? tryProfile(model.provider);
    if (profile) {
      return modelCapabilitiesFromProfile(profile, {
        model: model.model,
        ...(this.#contextTokens === undefined ? {} : { contextTokens: this.#contextTokens }),
        ...(this.#imageInput === undefined ? {} : { imageInput: this.#imageInput }),
      });
    }
    return {
      input: new Set(this.#imageInput ? ["text", "image"] : ["text"]),
      output: new Set(["text", "action"]),
      contextTokens: this.#contextTokens ?? 128_000,
      parallelActions: true,
      promptCache: false,
    };
  }

  async *stream(rawRequest: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const request = parseModelRequest(rawRequest);
    this.#assertProvider(request.model);
    const profile = this.#profile ?? tryProfile(request.model.provider);
    if (profile) {
      assertProfileSupportsRequest(profile, {
        toolCount: request.tools.length,
        model: request.model.model,
      });
    }
    throwIfAborted(signal);

    const thinking = profile === undefined
      ? undefined
      : chatThinkingConfig(profile, request.model.model, this.#reasoningEffort);
    const body: ChatCompletionCreateParamsStreaming & {
      thinking?: KimiThinkingConfig | DeepSeekThinkingConfig;
      reasoning_effort?: ProviderThinkingEffort;
    } = {
      model: request.model.model,
      messages: toChatMessages(request.messages),
      tools: request.tools.map(toChatTool),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxOutputTokens === undefined
        ? {}
        : profile?.id === "kimi"
          ? { max_completion_tokens: request.maxOutputTokens }
          : { max_tokens: request.maxOutputTokens }),
      ...(thinking?.thinking === undefined ? {} : { thinking: thinking.thinking }),
      ...(thinking?.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: thinking.reasoningEffort }),
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
      const reasoning = providerReasoningDelta(delta);
      if (reasoning !== undefined && reasoning.length > 0) {
        yield parseModelEvent({ type: "reasoning.delta", delta: reasoning });
      }
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

interface KimiThinkingConfig {
  readonly type: "enabled" | "disabled";
  readonly keep?: "all";
}

interface DeepSeekThinkingConfig {
  readonly type: "enabled" | "disabled";
}

interface ChatThinkingWire {
  readonly thinking?: KimiThinkingConfig | DeepSeekThinkingConfig;
  readonly reasoningEffort?: ProviderThinkingEffort;
}

function chatThinkingConfig(
  profile: ProviderProfile,
  model: string,
  requestedEffort: string | null | undefined,
): ChatThinkingWire | undefined {
  if (profile.id === "kimi") {
    const modelProfile = getProviderModelProfile(profile, model);
    const effort = normalizeReasoningEffort(requestedEffort);
    if (modelProfile?.thinking?.mode === "always") {
      if (effort === "none") {
        throw new TypeError(
          `Kimi model ${model} keeps thinking always on; reasoning effort "none" is not supported`,
        );
      }
      return { thinking: { type: "enabled", keep: "all" } };
    }
    if (effort === "none") return { thinking: { type: "disabled" } };
    if (!modelProfile?.thinking) {
      // Unknown / future model ID: pass top-level reasoning_effort when the operator set one.
      return effort === undefined ? undefined : { reasoningEffort: effort };
    }
    if (modelProfile.thinking.mode === "toggle") {
      return { thinking: { type: "enabled", keep: "all" } };
    }
    // K3 effort models: top-level reasoning_effort; do not nest effort inside thinking.
    const supported = modelProfile.thinking.supportedEfforts;
    const selected = effort !== undefined && supported?.includes(effort)
      ? effort
      : modelProfile.thinking.defaultEffort ?? supported?.[0] ?? "high";
    return { reasoningEffort: selected };
  }
  if (profile.id === "deepseek") {
    const modelProfile = getProviderModelProfile(profile, model);
    if (!modelProfile?.thinking && requestedEffort === undefined) return undefined;
    const effort = normalizeReasoningEffort(requestedEffort);
    if (effort === "none") return { thinking: { type: "disabled" } };
    const supported = modelProfile?.thinking?.supportedEfforts;
    const selected = effort !== undefined && supported?.includes(effort)
      ? effort
      : modelProfile?.thinking?.defaultEffort ?? supported?.[0] ?? effort;
    if (selected === undefined) return { thinking: { type: "enabled" } };
    return {
      thinking: { type: "enabled" },
      reasoningEffort: selected,
    };
  }
  return undefined;
}

/** Normalize operator effort aliases used by Kimi, DeepSeek, and Volcengine Agent Plan. */
export function normalizeReasoningEffort(
  value: string | null | undefined,
): ProviderThinkingEffort | "none" | undefined {
  if (value === undefined || value === null) return undefined;
  switch (value.trim().toLowerCase()) {
    case "ultra":
    case "max":
    case "xhigh":
      return "max";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
    case "minimum":
    case "light":
    case "minimal":
      return "low";
    case "none":
      return "none";
    default:
      throw new TypeError(
        `Unsupported reasoning effort "${value}"; expected ultra|max|xhigh|high|medium|low|minimum|minimal|light|none`,
      );
  }
}

/** @deprecated Prefer {@link normalizeReasoningEffort}. */
export function normalizeKimiReasoningEffort(
  value: string | null | undefined,
): ProviderThinkingEffort | "none" | undefined {
  return normalizeReasoningEffort(value);
}

function providerReasoningDelta(delta: ChatCompletionChunk["choices"][number]["delta"]): string | undefined {
  const candidate = delta as typeof delta & {
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
  if (typeof candidate.reasoning_content === "string") return candidate.reasoning_content;
  return typeof candidate.reasoning === "string" ? candidate.reasoning : undefined;
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
  // Chat Completions requires every tool_call_id to be answered by a contiguous run of
  // role=tool messages. Tool-result images become synthetic user messages, so defer them
  // until after that run — otherwise a second parallel read_image (e.g. read_image:1)
  // looks unanswered and the provider returns 400.
  const pendingToolMedia: ChatCompletionMessageParam[] = [];
  const flushToolMedia = (): void => {
    if (pendingToolMedia.length === 0) return;
    result.push(...pendingToolMedia);
    pendingToolMedia.length = 0;
  };

  for (const message of messages) {
    switch (message.role) {
      case "system":
        flushToolMedia();
        result.push({ role: "system", content: textOnly(message, "system") });
        break;
      case "user":
        flushToolMedia();
        result.push({ role: "user", content: toChatUserContent(message) });
        break;
      case "assistant": {
        flushToolMedia();
        const toolCalls = message.content.filter((part) => part.type === "tool-call");
        const text = message.content
          .filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");
        const reasoning = message.content
          .filter((part): part is Extract<ModelContentPart, { type: "reasoning" }> =>
            part.type === "reasoning"
          )
          .map((part) => part.text)
          .join("");
        const assistantMessage: ChatCompletionMessageParam & { reasoning_content?: string } =
          toolCalls.length > 0
            ? {
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
            }
            : { role: "assistant", content: text };
        if (reasoning) assistantMessage.reasoning_content = reasoning;
        result.push(assistantMessage);
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") {
            throw new TypeError("Tool messages may only contain tool-result parts");
          }
          const { output, images } = splitToolResultOutput(part.output);
          result.push({
            role: "tool",
            tool_call_id: part.callId,
            content: JSON.stringify({ ok: !part.isError, output }),
          });
          if (images.length > 0) {
            pendingToolMedia.push({
              role: "user",
              content: [
                { type: "text", text: `Attached media from tool result ${part.callId}:` },
                ...images.map(toChatImagePart),
              ],
            });
          }
        }
        break;
    }
  }
  flushToolMedia();
  return result;
}

function toChatUserContent(
  message: ModelMessage,
): string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  for (const part of message.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") content.push(toChatImagePart(part));
    else if (part.type === "reasoning") {
      throw new TypeError("user messages cannot contain reasoning parts");
    } else if (part.type === "artifact") {
      throw new TypeError(`Artifact ${part.ref} must be resolved before invoking the Chat Completions adapter`);
    } else {
      throw new TypeError(`user messages cannot contain ${part.type} parts`);
    }
  }
  if (content.length === 1 && content[0]?.type === "text") return content[0].text;
  return content;
}

function toChatImagePart(
  part: Extract<ModelContentPart, { type: "image" }>,
): { type: "image_url"; image_url: { url: string } } {
  assertSupportedImageUri(part);
  return { type: "image_url", image_url: { url: part.uri } };
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
      throw new TypeError(`Artifact ${item.ref} must be resolved before invoking the Chat Completions adapter`);
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

function textOnly(message: ModelMessage, role: string): string {
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "reasoning") {
      // System/user messages never carry provider CoT; ignore if present.
      continue;
    } else if (part.type === "image" || part.type === "artifact") {
      throw new TypeError(`Chat Completions adapter does not accept ${part.type} parts on ${role} messages`);
    } else {
      throw new TypeError(`${role} messages cannot contain ${part.type} parts`);
    }
  }
  return parts.join("");
}

function assertSupportedImageUri(part: Extract<ModelContentPart, { type: "image" }>): void {
  if (/^(https?:|data:)/i.test(part.uri)) return;
  throw new TypeError(
    `Chat Completions image input requires an http(s) URL or data URL; received ${part.uri}`,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The model request was aborted", "AbortError");
}
