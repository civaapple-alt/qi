import {
  getProviderModelProfile,
  resolveProviderWireHints,
  thinkingAllowsDisable,
  type ChatThinkingDialect,
  type ProviderProfile,
  type ProviderThinkingEffort,
  type ResponsesThinkingDialect,
} from "./provider-profile.js";

export interface ChatThinkingWire {
  readonly thinking?: { readonly type: "enabled" | "disabled"; readonly keep?: "all" };
  readonly reasoningEffort?: ProviderThinkingEffort;
  readonly enableThinking?: boolean;
}

export interface ResponsesThinkingWire {
  readonly thinking?: { readonly type: "enabled" | "disabled" };
  readonly reasoning?: { readonly effort: ProviderThinkingEffort | "none" };
}

/** Normalize operator effort aliases used across providers. */
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

function selectEffort(
  requested: ProviderThinkingEffort | "none" | undefined,
  supported: readonly ProviderThinkingEffort[] | undefined,
  defaultEffort: ProviderThinkingEffort | undefined,
): ProviderThinkingEffort | undefined {
  if (requested !== undefined && requested !== "none" && supported?.includes(requested)) {
    return requested;
  }
  if (requested !== undefined && requested !== "none" && !supported) {
    return requested;
  }
  return defaultEffort ?? supported?.[0];
}

function resolveChatDialect(
  profile: ProviderProfile,
  model: string,
): ChatThinkingDialect {
  return resolveProviderWireHints(profile, model).chatThinking ?? "none";
}

function resolveResponsesDialect(
  profile: ProviderProfile | undefined,
  model: string,
): ResponsesThinkingDialect {
  if (profile === undefined) return "reasoning_effort";
  return resolveProviderWireHints(profile, model).responsesThinking ?? "reasoning_effort";
}

/**
 * Map catalog thinking + dialect + operator effort into Chat Completions wire fields.
 * Adapters must not branch on `profile.id`.
 */
export function resolveChatThinkingWire(
  profile: ProviderProfile,
  model: string,
  requestedEffort: string | null | undefined,
): ChatThinkingWire | undefined {
  const dialect = resolveChatDialect(profile, model);
  if (dialect === "none") return undefined;

  const modelProfile = getProviderModelProfile(profile, model);
  const thinking = modelProfile?.thinking;
  const effort = normalizeReasoningEffort(requestedEffort);

  if (dialect === "thinking_keep_all") {
    if (effort === "none") {
      throw new TypeError(
        `Model ${model} keeps thinking always on; reasoning effort "none" is not supported`,
      );
    }
    return { thinking: { type: "enabled", keep: "all" } };
  }

  if (dialect === "kimi_effort") {
    if (thinking?.mode === "always") {
      if (effort === "none") {
        throw new TypeError(
          `Model ${model} keeps thinking always on; reasoning effort "none" is not supported`,
        );
      }
      return { thinking: { type: "enabled", keep: "all" } };
    }
    // Catalog may omit `none` from UI (allowDisable=false) while still accepting wire disable.
    if (effort === "none") return { thinking: { type: "disabled" } };
    if (!thinking) {
      return effort === undefined ? undefined : { reasoningEffort: effort };
    }
    if (thinking.mode === "toggle") {
      return { thinking: { type: "enabled", keep: "all" } };
    }
    const selected = selectEffort(effort, thinking.supportedEfforts, thinking.defaultEffort) ?? "high";
    return { reasoningEffort: selected };
  }

  if (dialect === "enable_thinking_and_effort") {
    if (!thinking && requestedEffort === undefined) return undefined;
    if (effort === "none") return { enableThinking: false };
    const selected = selectEffort(effort, thinking?.supportedEfforts, thinking?.defaultEffort) ?? effort;
    return {
      enableThinking: true,
      ...(selected === undefined ? {} : { reasoningEffort: selected }),
    };
  }

  if (dialect === "thinking_type_and_effort") {
    if (!thinking && requestedEffort === undefined) return undefined;
    if (effort === "none") return { thinking: { type: "disabled" } };
    const selected = selectEffort(effort, thinking?.supportedEfforts, thinking?.defaultEffort) ?? effort;
    if (selected === undefined) return { thinking: { type: "enabled" } };
    return { thinking: { type: "enabled" }, reasoningEffort: selected };
  }

  // reasoning_effort (top-level only)
  if (!thinking && requestedEffort === undefined) return undefined;
  if (effort === "none") {
    if (thinking && !thinkingAllowsDisable(thinking)) {
      throw new TypeError(`Model ${model} does not allow disabling thinking`);
    }
    return undefined;
  }
  if (!thinking) {
    return effort === undefined ? undefined : { reasoningEffort: effort };
  }
  if (thinking.mode === "always" || thinking.mode === "toggle") {
    return { reasoningEffort: thinking.defaultEffort ?? "high" };
  }
  const selected = selectEffort(effort, thinking.supportedEfforts, thinking.defaultEffort) ?? "high";
  return { reasoningEffort: selected };
}

/**
 * Map catalog thinking + dialect + operator effort into Responses wire fields.
 */
export function resolveResponsesThinkingWire(
  profile: ProviderProfile | undefined,
  model: string,
  requestedEffort: string | null | undefined,
): ResponsesThinkingWire | undefined {
  if (profile === undefined) {
    const effort = normalizeReasoningEffort(requestedEffort);
    return effort === undefined ? undefined : { reasoning: { effort } };
  }

  const modelProfile = getProviderModelProfile(profile, model);
  if (modelProfile !== undefined && modelProfile.thinking === undefined) return undefined;
  if (modelProfile?.thinking === undefined && requestedEffort === undefined) return undefined;

  const dialect = resolveResponsesDialect(profile, model);
  const effort = normalizeReasoningEffort(requestedEffort);
  const thinking = modelProfile?.thinking;

  if (dialect === "thinking_type_and_reasoning_effort") {
    if (effort === "none") return { thinking: { type: "disabled" } };
    if (thinking === undefined) {
      if (effort === undefined) return undefined;
      return { thinking: { type: "enabled" }, reasoning: { effort } };
    }
    if (thinking.mode === "toggle" || thinking.mode === "always") {
      return {
        thinking: { type: "enabled" },
        reasoning: { effort: thinking.defaultEffort ?? "high" },
      };
    }
    const selected = selectEffort(effort, thinking.supportedEfforts, thinking.defaultEffort) ?? "high";
    return { thinking: { type: "enabled" }, reasoning: { effort: selected } };
  }

  // reasoning_effort
  if (effort === "none") return { reasoning: { effort: "none" } };
  if (thinking === undefined) {
    if (effort === undefined) return undefined;
    return { reasoning: { effort } };
  }
  if (thinking.mode === "toggle" || thinking.mode === "always") {
    return { reasoning: { effort: thinking.defaultEffort ?? "high" } };
  }
  const selected = selectEffort(effort, thinking.supportedEfforts, thinking.defaultEffort) ?? "high";
  return { reasoning: { effort: selected } };
}

export function resolveChatOutputTokenField(
  profile: ProviderProfile,
  model: string,
): "max_tokens" | "max_completion_tokens" {
  return resolveProviderWireHints(profile, model).chatOutputTokenField ?? "max_tokens";
}
