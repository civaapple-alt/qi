import {
  BUILTIN_PROVIDER_PROFILES,
  installProviderCatalog,
  type ChatOutputTokenField,
  type ChatThinkingDialect,
  type ProviderAuthScheme,
  type ProviderModelDiscovery,
  type ProviderModelProfile,
  type ProviderModelThinking,
  type ProviderProfile,
  type ProviderThinkingEffort,
  type ProviderTransportCapabilities,
  type ProviderWireApi,
  type ProviderWireHints,
  type ResponsesThinkingDialect,
} from "./provider-profile.js";

const WIRE_APIS = new Set<ProviderWireApi>(["responses", "chat.completions"]);
const AUTH_SCHEMES = new Set<ProviderAuthScheme>(["api-key", "oauth-device"]);
const EFFORTS = new Set<ProviderThinkingEffort>(["low", "medium", "high", "max"]);
const THINKING_MODES = new Set(["toggle", "effort", "always"]);
const CHAT_THINKING = new Set<ChatThinkingDialect>([
  "none",
  "reasoning_effort",
  "kimi_effort",
  "thinking_keep_all",
  "thinking_type_and_effort",
  "enable_thinking_and_effort",
]);
const RESPONSES_THINKING = new Set<ResponsesThinkingDialect>([
  "reasoning_effort",
  "thinking_type_and_reasoning_effort",
]);
const OUTPUT_FIELDS = new Set<ChatOutputTokenField>(["max_tokens", "max_completion_tokens"]);
const DISCOVERY = new Set<ProviderModelDiscovery>(["none", "openai_compatible"]);
const MODALITIES = new Set(["text", "image"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** TOML snake_case keys that must keep Qi's existing camelCase acronyms (URL / API). */
const SNAKE_KEY_ALIASES: Readonly<Record<string, string>> = {
  official_base_url: "officialBaseURL",
  env_api_key: "envApiKey",
  env_base_url: "envBaseURL",
  wire_api: "wireApi",
  chat_output_token_field: "chatOutputTokenField",
};

function snakeToCamelKey(key: string): string {
  if (SNAKE_KEY_ALIASES[key] !== undefined) return SNAKE_KEY_ALIASES[key]!;
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** Recursively convert snake_case keys to camelCase (TOML documents). */
export function camelizeCatalogKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeCatalogKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[snakeToCamelKey(key)] = camelizeCatalogKeys(nested);
  }
  return out;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requirePositiveInt(value: unknown, label: string, min = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new TypeError(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, label: string, min = 1): number | undefined {
  if (value === undefined) return undefined;
  return requirePositiveInt(value, label, min);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function parseWireApi(value: unknown, label: string): ProviderWireApi {
  const wire = requireString(value, label);
  if (!WIRE_APIS.has(wire as ProviderWireApi)) {
    throw new TypeError(`${label} must be "responses" or "chat.completions"`);
  }
  return wire as ProviderWireApi;
}

function parseWireHints(value: unknown, label: string): ProviderWireHints | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a table`);
  const chatThinking = value.chatThinking === undefined
    ? undefined
    : requireString(value.chatThinking, `${label}.chatThinking`);
  if (chatThinking !== undefined && !CHAT_THINKING.has(chatThinking as ChatThinkingDialect)) {
    throw new TypeError(`${label}.chatThinking is not a supported dialect`);
  }
  const responsesThinking = value.responsesThinking === undefined
    ? undefined
    : requireString(value.responsesThinking, `${label}.responsesThinking`);
  if (
    responsesThinking !== undefined
    && !RESPONSES_THINKING.has(responsesThinking as ResponsesThinkingDialect)
  ) {
    throw new TypeError(`${label}.responsesThinking is not a supported dialect`);
  }
  const chatOutputTokenField = value.chatOutputTokenField === undefined
    ? undefined
    : requireString(value.chatOutputTokenField, `${label}.chatOutputTokenField`);
  if (
    chatOutputTokenField !== undefined
    && !OUTPUT_FIELDS.has(chatOutputTokenField as ChatOutputTokenField)
  ) {
    throw new TypeError(`${label}.chatOutputTokenField must be max_tokens or max_completion_tokens`);
  }
  return {
    ...(chatThinking === undefined ? {} : { chatThinking: chatThinking as ChatThinkingDialect }),
    ...(responsesThinking === undefined
      ? {}
      : { responsesThinking: responsesThinking as ResponsesThinkingDialect }),
    ...(chatOutputTokenField === undefined
      ? {}
      : { chatOutputTokenField: chatOutputTokenField as ChatOutputTokenField }),
  };
}

function parseThinking(value: unknown, label: string): ProviderModelThinking {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a table`);
  const mode = requireString(value.mode, `${label}.mode`);
  if (!THINKING_MODES.has(mode)) {
    throw new TypeError(`${label}.mode must be toggle|effort|always`);
  }
  const allowDisable = optionalBoolean(value.allowDisable, `${label}.allowDisable`);
  if (mode === "always" && allowDisable === true) {
    throw new TypeError(`${label}.allowDisable cannot be true when mode is always`);
  }
  let supportedEfforts: ProviderThinkingEffort[] | undefined;
  if (value.supportedEfforts !== undefined) {
    if (!Array.isArray(value.supportedEfforts)) {
      throw new TypeError(`${label}.supportedEfforts must be an array`);
    }
    supportedEfforts = value.supportedEfforts.map((item, index) => {
      const effort = requireString(item, `${label}.supportedEfforts[${index}]`);
      if (!EFFORTS.has(effort as ProviderThinkingEffort)) {
        throw new TypeError(`${label}.supportedEfforts[${index}] is not a portable effort`);
      }
      return effort as ProviderThinkingEffort;
    });
  }
  const defaultEffort = value.defaultEffort === undefined
    ? undefined
    : requireString(value.defaultEffort, `${label}.defaultEffort`) as ProviderThinkingEffort;
  if (defaultEffort !== undefined && !EFFORTS.has(defaultEffort)) {
    throw new TypeError(`${label}.defaultEffort is not a portable effort`);
  }
  let resolvedDefault = defaultEffort;
  if (mode === "effort") {
    if (!supportedEfforts || supportedEfforts.length === 0) {
      throw new TypeError(`${label}.supportedEfforts is required when mode is effort`);
    }
    resolvedDefault = defaultEffort ?? (supportedEfforts.includes("high") ? "high" : supportedEfforts[0]!);
    if (!supportedEfforts.includes(resolvedDefault)) {
      throw new TypeError(`${label}.defaultEffort must be listed in supportedEfforts`);
    }
  }
  let effortLabels: ProviderModelThinking["effortLabels"];
  if (value.effortLabels !== undefined) {
    if (!isPlainObject(value.effortLabels)) {
      throw new TypeError(`${label}.effortLabels must be a table`);
    }
    const labels: Record<string, string> = {};
    for (const [key, text] of Object.entries(value.effortLabels)) {
      labels[key] = requireString(text, `${label}.effortLabels.${key}`);
    }
    effortLabels = labels;
  }
  return {
    mode: mode as ProviderModelThinking["mode"],
    ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
    ...(resolvedDefault === undefined ? {} : { defaultEffort: resolvedDefault }),
    ...(allowDisable === undefined ? {} : { allowDisable }),
    ...(effortLabels === undefined ? {} : { effortLabels }),
  };
}

function parseModalities(value: unknown, label: string): readonly ("text" | "image")[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => {
    const modality = requireString(item, `${label}[${index}]`);
    if (!MODALITIES.has(modality)) {
      throw new TypeError(`${label}[${index}] must be text or image`);
    }
    return modality as "text" | "image";
  });
}

function parseModel(value: unknown, label: string): ProviderModelProfile {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a table`);
  const id = requireString(value.id, `${label}.id`);
  const thinking = value.thinking === undefined
    ? undefined
    : parseThinking(value.thinking, `${label}.thinking`);
  const percent = optionalPositiveInt(
    value.effectiveContextWindowPercent,
    `${label}.effectiveContextWindowPercent`,
    1,
  );
  if (percent !== undefined && percent > 100) {
    throw new TypeError(`${label}.effectiveContextWindowPercent must be <= 100`);
  }
  const modalities = parseModalities(value.inputModalities, `${label}.inputModalities`);
  const wire = parseWireHints(value.wire, `${label}.wire`);
  const outputReserveTokens = optionalPositiveInt(
    value.outputReserveTokens,
    `${label}.outputReserveTokens`,
  );
  const imageInputDefault = optionalBoolean(value.imageInputDefault, `${label}.imageInputDefault`);
  const parallelToolCalls = optionalBoolean(value.parallelToolCalls, `${label}.parallelToolCalls`);
  return {
    id,
    displayName: requireString(value.displayName, `${label}.displayName`),
    contextTokens: requirePositiveInt(value.contextTokens, `${label}.contextTokens`, 8_192),
    ...(modalities === undefined ? {} : { inputModalities: modalities }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(value.wireApi === undefined ? {} : { wireApi: parseWireApi(value.wireApi, `${label}.wireApi`) }),
    ...(wire === undefined ? {} : { wire }),
    ...(outputReserveTokens === undefined ? {} : { outputReserveTokens }),
    ...(percent === undefined ? {} : { effectiveContextWindowPercent: percent }),
    ...(imageInputDefault === undefined ? {} : { imageInputDefault }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
  };
}

function parseCapabilities(value: unknown, label: string): ProviderTransportCapabilities {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a table`);
  const flag = (key: keyof ProviderTransportCapabilities): boolean => {
    const raw = value[key];
    if (typeof raw !== "boolean") throw new TypeError(`${label}.${key} must be a boolean`);
    return raw;
  };
  return {
    chatCompletions: flag("chatCompletions"),
    responses: flag("responses"),
    streaming: flag("streaming"),
    toolCalls: flag("toolCalls"),
    reasoning: flag("reasoning"),
    usage: flag("usage"),
    requestMetadata: flag("requestMetadata"),
  };
}

function parseProvider(value: unknown, label: string): ProviderProfile {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a table`);
  const hosts = value.officialHosts;
  if (!Array.isArray(hosts)) throw new TypeError(`${label}.officialHosts must be an array`);
  const authSchemes = value.authSchemes;
  if (!Array.isArray(authSchemes) || authSchemes.length === 0) {
    throw new TypeError(`${label}.authSchemes must be a non-empty array`);
  }
  const schemes = authSchemes.map((item, index) => {
    const scheme = requireString(item, `${label}.authSchemes[${index}]`);
    if (!AUTH_SCHEMES.has(scheme as ProviderAuthScheme)) {
      throw new TypeError(`${label}.authSchemes[${index}] must be api-key or oauth-device`);
    }
    return scheme as ProviderAuthScheme;
  });
  const discovery = value.modelDiscovery === undefined
    ? undefined
    : requireString(value.modelDiscovery, `${label}.modelDiscovery`);
  if (discovery !== undefined && !DISCOVERY.has(discovery as ProviderModelDiscovery)) {
    throw new TypeError(`${label}.modelDiscovery must be none or openai_compatible`);
  }
  const models = value.models === undefined
    ? undefined
    : (Array.isArray(value.models)
      ? value.models.map((item, index) => parseModel(item, `${label}.models[${index}]`))
      : (() => {
        throw new TypeError(`${label}.models must be an array`);
      })());
  const percent = optionalPositiveInt(
    value.effectiveContextWindowPercent,
    `${label}.effectiveContextWindowPercent`,
    1,
  );
  if (percent !== undefined && percent > 100) {
    throw new TypeError(`${label}.effectiveContextWindowPercent must be <= 100`);
  }
  const defaultModel = optionalString(value.defaultModel, `${label}.defaultModel`);
  const modalities = parseModalities(value.inputModalities, `${label}.inputModalities`);
  const wire = parseWireHints(value.wire, `${label}.wire`);
  const outputReserveTokens = optionalPositiveInt(
    value.outputReserveTokens,
    `${label}.outputReserveTokens`,
  );
  const imageInputDefault = optionalBoolean(value.imageInputDefault, `${label}.imageInputDefault`);
  const envApiKey = optionalString(value.envApiKey, `${label}.envApiKey`);
  const envBaseURL = optionalString(value.envBaseURL, `${label}.envBaseURL`);
  const envModel = optionalString(value.envModel, `${label}.envModel`);
  return {
    id: requireString(value.id, `${label}.id`),
    displayName: requireString(value.displayName, `${label}.displayName`),
    wireApi: parseWireApi(value.wireApi, `${label}.wireApi`),
    officialBaseURL: requireString(value.officialBaseURL, `${label}.officialBaseURL`),
    officialHosts: hosts.map((host, index) => requireString(host, `${label}.officialHosts[${index}]`)),
    authSchemes: schemes,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    contextTokens: requirePositiveInt(value.contextTokens, `${label}.contextTokens`, 8_192),
    ...(models === undefined ? {} : { models }),
    capabilities: parseCapabilities(value.capabilities, `${label}.capabilities`),
    ...(modalities === undefined ? {} : { inputModalities: modalities }),
    ...(wire === undefined ? {} : { wire }),
    ...(outputReserveTokens === undefined ? {} : { outputReserveTokens }),
    ...(percent === undefined ? {} : { effectiveContextWindowPercent: percent }),
    ...(imageInputDefault === undefined ? {} : { imageInputDefault }),
    ...(discovery === undefined ? {} : { modelDiscovery: discovery as ProviderModelDiscovery }),
    ...(envApiKey === undefined ? {} : { envApiKey }),
    ...(envBaseURL === undefined ? {} : { envBaseURL }),
    ...(envModel === undefined ? {} : { envModel }),
  };
}

/**
 * Validate a camelCase (or already-normalized) catalog document.
 * Accepts `{ provider: [...] }`, `{ providers: [...] }`, a bare provider object, or an array.
 */
export function parseProviderCatalogDocument(document: unknown): readonly ProviderProfile[] {
  const normalized = camelizeCatalogKeys(document);
  if (Array.isArray(normalized)) {
    return normalized.map((item, index) => parseProvider(item, `providers[${index}]`));
  }
  if (!isPlainObject(normalized)) {
    throw new TypeError("Provider catalog document must be a table or array");
  }
  const list = normalized.provider ?? normalized.providers;
  if (list !== undefined) {
    if (!Array.isArray(list)) throw new TypeError("provider/providers must be an array");
    return list.map((item, index) => parseProvider(item, `provider[${index}]`));
  }
  return [parseProvider(normalized, "provider")];
}

function mergeModels(
  base: readonly ProviderModelProfile[] | undefined,
  overlay: readonly ProviderModelProfile[] | undefined,
): readonly ProviderModelProfile[] | undefined {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  const byId = new Map(base.map((model) => [model.id, model]));
  for (const model of overlay) {
    byId.set(model.id, model);
  }
  return [...byId.values()];
}

/** Deep-merge provider catalogs by id; same model id is replaced wholesale; new ids append. */
export function mergeProviderCatalogs(
  ...layers: readonly (readonly ProviderProfile[])[]
): readonly ProviderProfile[] {
  const byId = new Map<string, ProviderProfile>();
  for (const layer of layers) {
    for (const profile of layer) {
      const existing = byId.get(profile.id);
      if (!existing) {
        byId.set(profile.id, profile);
        continue;
      }
      const models = mergeModels(existing.models, profile.models);
      const wire = { ...(existing.wire ?? {}), ...(profile.wire ?? {}) };
      const inputModalities = profile.inputModalities ?? existing.inputModalities;
      byId.set(profile.id, {
        ...existing,
        ...profile,
        capabilities: profile.capabilities,
        officialHosts: profile.officialHosts,
        authSchemes: profile.authSchemes,
        ...(models === undefined ? {} : { models }),
        ...(Object.keys(wire).length === 0 ? {} : { wire }),
        ...(inputModalities === undefined ? {} : { inputModalities }),
      });
    }
  }
  return [...byId.values()];
}

/** Merge overlays onto built-ins and install (replaces any previously installed registry). */
export function installProviderCatalogOverBuiltins(
  ...overlays: readonly (readonly ProviderProfile[])[]
): readonly ProviderProfile[] {
  const merged = mergeProviderCatalogs(BUILTIN_PROVIDER_PROFILES, ...overlays);
  installProviderCatalog(merged);
  return merged;
}
