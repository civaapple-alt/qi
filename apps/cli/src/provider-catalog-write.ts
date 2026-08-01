import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getProviderProfile,
  type ChatOutputTokenField,
  type ChatThinkingDialect,
  type ProviderProfile,
  type ProviderWireApi,
  type ResponsesThinkingDialect,
} from "@civaapple/qi-ai";
import {
  defaultProviderCatalogDirectory,
  loadAndInstallUserProviderCatalog,
} from "./provider-catalog-files.js";
import { normalizeAccountAlias } from "./provider.js";

const BUILTIN_PROVIDER_IDS = new Set([
  "openai",
  "xai",
  "kimi",
  "deepseek",
  "volcengine-agent-plan",
  "qianwenai",
  "moonshot",
  "compatible",
]);

export interface CustomCompatibleModelInput {
  readonly id: string;
  readonly contextTokens: number;
  readonly outputReserveTokens: number;
}

export interface WriteCustomOpenAiCompatibleProviderInput {
  /** Display name / provider id source (e.g. xiaomi). */
  readonly name: string;
  readonly baseURL: string;
  readonly models: readonly CustomCompatibleModelInput[];
  /** Default `chat.completions`. */
  readonly wireApi?: ProviderWireApi;
  /** Chat Completions thinking dialect; ignored when wire is Responses. */
  readonly chatThinking?: ChatThinkingDialect;
  /** Responses thinking dialect; ignored when wire is Chat Completions. */
  readonly responsesThinking?: ResponsesThinkingDialect;
  /** Chat Completions max-output field; default `max_tokens`. */
  readonly chatOutputTokenField?: ChatOutputTokenField;
  /** Optional override for the written file directory. */
  readonly directory?: string;
}

export function parseProviderWireApi(value: string | undefined): ProviderWireApi {
  const normalized = (value ?? "chat.completions").trim().toLowerCase();
  if (normalized === "responses" || normalized === "response") return "responses";
  if (
    normalized === "chat.completions"
    || normalized === "chat"
    || normalized === "chat_completions"
    || normalized === "completions"
  ) {
    return "chat.completions";
  }
  throw new TypeError(
    `Unsupported wire API "${value}"; expected chat.completions or responses`,
  );
}

export function parseChatThinkingDialect(value: string | undefined): ChatThinkingDialect {
  const normalized = (value ?? "none").trim().toLowerCase();
  const allowed: readonly ChatThinkingDialect[] = [
    "none",
    "reasoning_effort",
    "kimi_effort",
    "thinking_keep_all",
    "thinking_type_and_effort",
    "enable_thinking_and_effort",
  ];
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as ChatThinkingDialect;
  }
  throw new TypeError(
    `Unsupported chat thinking dialect "${value}"; expected ${allowed.join("|")}`,
  );
}

export function parseResponsesThinkingDialect(
  value: string | undefined,
): ResponsesThinkingDialect {
  const normalized = (value ?? "reasoning_effort").trim().toLowerCase();
  const allowed: readonly ResponsesThinkingDialect[] = [
    "reasoning_effort",
    "thinking_type_and_reasoning_effort",
  ];
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as ResponsesThinkingDialect;
  }
  throw new TypeError(
    `Unsupported responses thinking dialect "${value}"; expected ${allowed.join("|")}`,
  );
}

export function parseChatOutputTokenField(value: string | undefined): ChatOutputTokenField {
  const normalized = (value ?? "max_tokens").trim().toLowerCase();
  if (normalized === "max_tokens" || normalized === "max_completion_tokens") {
    return normalized;
  }
  throw new TypeError(
    `Unsupported output token field "${value}"; expected max_tokens or max_completion_tokens`,
  );
}

export interface WrittenCustomProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly path: string;
  readonly profile: ProviderProfile;
}

/** Normalize a user-facing name into a provider catalog id. */
export function normalizeProviderCatalogId(value: string): string {
  const alias = normalizeAccountAlias(value);
  if (BUILTIN_PROVIDER_IDS.has(alias)) {
    throw new TypeError(
      `Name "${value}" conflicts with a built-in provider id; choose another name`,
    );
  }
  return alias;
}

const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000;

/**
 * Parse a token-count field: plain integer, or `128k` / `1m` (decimal thousand / million).
 */
export function parseTokenCount(value: string, label: string): number {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new TypeError(`${label} is required`);
  }
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(trimmed);
  if (!match) {
    throw new TypeError(
      `${label} must be a positive integer or k/m suffix (e.g. 128000, 256k, 1m); got "${value}"`,
    );
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) {
    throw new TypeError(`${label} must be a positive number (got "${value}")`);
  }
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const parsed = base * multiplier;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must resolve to a positive integer (got "${value}")`);
  }
  return parsed;
}

/** Build one model entry from separate form fields (defaults: 128000 / 16000). */
export function buildCompatibleModelFromFields(input: {
  readonly modelId: string;
  readonly contextWindowTokens?: string | undefined;
  readonly outputReserveTokens?: string | undefined;
}): CustomCompatibleModelInput {
  const id = input.modelId.trim();
  if (!id) {
    throw new TypeError("Model ID is required");
  }
  if (/\s/.test(id)) {
    throw new TypeError(`Model ID cannot contain whitespace (got "${id}")`);
  }
  const contextRaw = input.contextWindowTokens?.trim() ?? "";
  const outputRaw = input.outputReserveTokens?.trim() ?? "";
  const contextTokens = contextRaw.length === 0
    ? DEFAULT_CONTEXT_TOKENS
    : parseTokenCount(contextRaw, "context_window_tokens");
  const outputReserveTokens = outputRaw.length === 0
    ? DEFAULT_OUTPUT_RESERVE_TOKENS
    : parseTokenCount(outputRaw, "output_reserve_tokens");
  if (contextTokens < 8_192) {
    throw new TypeError(`context_window_tokens must be >= 8192 (model ${id})`);
  }
  if (outputReserveTokens < 1) {
    throw new TypeError(`output_reserve_tokens must be >= 1 (model ${id})`);
  }
  return { id, contextTokens, outputReserveTokens };
}

/**
 * Parse multiline model specs (tests / advanced):
 * `model_id [context_window_tokens] [output_reserve_tokens]`
 * Defaults: context 128000, output 16000. Token counts accept `k`/`m` suffixes.
 */
export function parseCompatibleModelLines(text: string): CustomCompatibleModelInput[] {
  const lines = text
    .split(/[\r\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new TypeError("At least one model line is required");
  }
  const models: CustomCompatibleModelInput[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const parts = line.split(/[\s,]+/).filter(Boolean);
    const id = parts[0];
    if (!id) continue;
    if (seen.has(id)) {
      throw new TypeError(`Duplicate model id "${id}"`);
    }
    seen.add(id);
    models.push(
      buildCompatibleModelFromFields({
        modelId: id,
        contextWindowTokens: parts[1],
        outputReserveTokens: parts[2],
      }),
    );
  }
  return models;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderCustomOpenAiCompatibleToml(input: {
  readonly providerId: string;
  readonly displayName: string;
  readonly baseURL: string;
  readonly host: string;
  readonly models: readonly CustomCompatibleModelInput[];
  readonly wireApi: ProviderWireApi;
  readonly chatThinking: ChatThinkingDialect;
  readonly responsesThinking: ResponsesThinkingDialect;
  readonly chatOutputTokenField: ChatOutputTokenField;
}): string {
  const defaultModel = input.models[0]!;
  const isResponses = input.wireApi === "responses";
  const reasoningEnabled = isResponses
    ? true
    : input.chatThinking !== "none";
  const lines: string[] = [
    `[[provider]]`,
    `id = "${escapeTomlString(input.providerId)}"`,
    `display_name = "${escapeTomlString(input.displayName)}"`,
    `wire_api = "${input.wireApi}"`,
    `official_base_url = "${escapeTomlString(input.baseURL)}"`,
    `official_hosts = ["${escapeTomlString(input.host)}"]`,
    `auth_schemes = ["api-key"]`,
    `default_model = "${escapeTomlString(defaultModel.id)}"`,
    `context_tokens = ${defaultModel.contextTokens}`,
    `output_reserve_tokens = ${defaultModel.outputReserveTokens}`,
    `input_modalities = ["text"]`,
    `image_input_default = false`,
    `model_discovery = "openai_compatible"`,
    ``,
    `[provider.capabilities]`,
    `chat_completions = ${isResponses ? "false" : "true"}`,
    `responses = ${isResponses ? "true" : "false"}`,
    `streaming = true`,
    `tool_calls = true`,
    `reasoning = ${reasoningEnabled ? "true" : "false"}`,
    `usage = true`,
    `request_metadata = false`,
    ``,
    `[provider.wire]`,
  ];
  if (isResponses) {
    lines.push(`responses_thinking = "${input.responsesThinking}"`);
  } else {
    lines.push(
      `chat_thinking = "${input.chatThinking}"`,
      `chat_output_token_field = "${input.chatOutputTokenField}"`,
    );
  }

  for (const model of input.models) {
    lines.push(
      ``,
      `[[provider.models]]`,
      `id = "${escapeTomlString(model.id)}"`,
      `display_name = "${escapeTomlString(model.id)}"`,
      `context_tokens = ${model.contextTokens}`,
      `output_reserve_tokens = ${model.outputReserveTokens}`,
      `input_modalities = ["text"]`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}

/**
 * Write `$QI_HOME/providers/<id>.toml` for a custom OpenAI-compatible vendor and reload the catalog.
 */
export async function writeCustomOpenAiCompatibleProvider(
  input: WriteCustomOpenAiCompatibleProviderInput,
): Promise<WrittenCustomProvider> {
  if (input.models.length === 0) {
    throw new TypeError("At least one model is required");
  }
  const providerId = normalizeProviderCatalogId(input.name);
  const displayName = input.name.trim() || providerId;
  const baseURL = new URL(input.baseURL.trim()).toString().replace(/\/+$/, "");
  const host = new URL(baseURL).hostname.toLowerCase();
  if (!host) throw new TypeError("base URL must include a hostname");

  const wireApi = input.wireApi ?? "chat.completions";
  const chatThinking = input.chatThinking ?? "none";
  const responsesThinking = input.responsesThinking ?? "reasoning_effort";
  const chatOutputTokenField = input.chatOutputTokenField ?? "max_tokens";
  const directory = input.directory ?? defaultProviderCatalogDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${providerId}.toml`);
  const body = renderCustomOpenAiCompatibleToml({
    providerId,
    displayName,
    baseURL,
    host,
    models: input.models,
    wireApi,
    chatThinking,
    responsesThinking,
    chatOutputTokenField,
  });
  await writeFile(path, body, "utf8");
  await loadAndInstallUserProviderCatalog(directory);
  const profile = getProviderProfile(providerId);
  if (!profile) {
    throw new TypeError(`Failed to install provider catalog for ${providerId}`);
  }
  return { providerId, displayName, path, profile };
}
