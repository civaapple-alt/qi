import type { ModelCapabilities } from "./model.js";
import builtinProvidersJson from "./catalog/builtin-providers.json" with { type: "json" };

/** Wire protocol selected by an explicit profile — never inferred from failed requests. */
export type ProviderWireApi = "responses" | "chat.completions";

export type ProviderAuthScheme = "api-key" | "oauth-device";

export type ProviderModelDiscovery = "none" | "openai_compatible";

export interface ProviderTransportCapabilities {
  readonly chatCompletions: boolean;
  readonly responses: boolean;
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly reasoning: boolean;
  readonly usage: boolean;
  readonly requestMetadata: boolean;
}

export type ProviderThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ChatThinkingDialect =
  | "none"
  | "reasoning_effort"
  /** Kimi K3: `none` → thinking.disabled; effort → top-level reasoning_effort; toggle → keep=all. */
  | "kimi_effort"
  | "thinking_keep_all"
  | "thinking_type_and_effort"
  | "enable_thinking_and_effort";

export type ResponsesThinkingDialect =
  | "reasoning_effort"
  | "thinking_type_and_reasoning_effort"
  /** Responses providers that require the prior reasoning output item on tool continuation. */
  | "reasoning_item";

export type ChatOutputTokenField = "max_tokens" | "max_completion_tokens";

/** Closed wire-field dialects; adapters interpret these without `profile.id` branches. */
export interface ProviderWireHints {
  readonly chatThinking?: ChatThinkingDialect;
  readonly responsesThinking?: ResponsesThinkingDialect;
  readonly chatOutputTokenField?: ChatOutputTokenField;
}

export interface ProviderModelThinking {
  /**
   * `toggle` — operator may enable/disable thinking.
   * `effort` — thinking stays on; operator selects an effort level.
   * `always` — thinking is always on and cannot be disabled (e.g. Kimi K2.7 Code).
   */
  readonly mode: "toggle" | "effort" | "always";
  readonly supportedEfforts?: readonly ProviderThinkingEffort[];
  readonly defaultEffort?: ProviderThinkingEffort;
  /**
   * When true, UI/routing may advertise `none`.
   * Defaults: `toggle` → true; `effort` → false; `always` → false (and must not be true).
   */
  readonly allowDisable?: boolean;
  /** Optional UI labels for effort values (including `none`). */
  readonly effortLabels?: Readonly<Partial<Record<ProviderThinkingEffort | "none", string>>>;
}

export interface ProviderModelProfile {
  readonly id: string;
  readonly displayName: string;
  readonly contextTokens: number;
  readonly inputModalities?: readonly ("text" | "image")[];
  readonly thinking?: ProviderModelThinking;
  /** Optional per-model wire API override when one vendor exposes mixed protocols. */
  readonly wireApi?: ProviderWireApi;
  readonly wire?: ProviderWireHints;
  /**
   * Recommended next-response reserve (includes hidden reasoning when the provider counts it).
   * Composition roots may raise the default output reserve up to this value, still capped by the window.
   */
  readonly outputReserveTokens?: number;
  /** Percent of the window available to the Context Compiler before output reserve (1–100). */
  readonly effectiveContextWindowPercent?: number;
  /** Operator default for image input when the model supports images. */
  readonly imageInputDefault?: boolean;
  /** When set, overrides profile/tool capability for parallel tool calls. */
  readonly parallelToolCalls?: boolean;
}

export interface ProviderProfile {
  readonly id: string;
  readonly displayName: string;
  readonly wireApi: ProviderWireApi;
  readonly officialBaseURL: string;
  readonly officialHosts: readonly string[];
  readonly authSchemes: readonly ProviderAuthScheme[];
  readonly defaultModel?: string;
  readonly contextTokens: number;
  readonly models?: readonly ProviderModelProfile[];
  readonly capabilities: ProviderTransportCapabilities;
  /** Input modalities enabled by the official profile. Custom compatible endpoints remain text-only by default. */
  readonly inputModalities?: readonly ("text" | "image")[];
  readonly wire?: ProviderWireHints;
  readonly outputReserveTokens?: number;
  readonly effectiveContextWindowPercent?: number;
  readonly imageInputDefault?: boolean;
  /** How authenticated surfaces discover remote model ids (authority stays on the catalog). */
  readonly modelDiscovery?: ProviderModelDiscovery;
  /** Environment variable preferred for official API-key auth. */
  readonly envApiKey?: string;
  readonly envBaseURL?: string;
  readonly envModel?: string;
}

function asProfiles(value: unknown): readonly ProviderProfile[] {
  if (!Array.isArray(value)) {
    throw new TypeError("builtin-providers.json must be an array of provider profiles");
  }
  return Object.freeze(value.map((item) => Object.freeze(item as ProviderProfile)));
}

/** Built-in catalog loaded from declarative JSON (see `src/catalog/`). */
export const BUILTIN_PROVIDER_PROFILES: readonly ProviderProfile[] = asProfiles(builtinProvidersJson);

let activeProfiles: readonly ProviderProfile[] = BUILTIN_PROVIDER_PROFILES;
let profileById = new Map(activeProfiles.map((profile) => [profile.id, profile]));

/** Replace the process-wide provider registry (tests and CLI user overlays). */
export function installProviderCatalog(profiles: readonly ProviderProfile[]): void {
  activeProfiles = Object.freeze([...profiles]);
  profileById = new Map(activeProfiles.map((profile) => [profile.id, profile]));
}

/** Restore the shipped built-in catalog. */
export function resetProviderCatalog(): void {
  installProviderCatalog(BUILTIN_PROVIDER_PROFILES);
}

export function getProviderProfile(id: string): ProviderProfile | undefined {
  return profileById.get(id);
}

export function requireProviderProfile(id: string): ProviderProfile {
  const profile = getProviderProfile(id);
  if (!profile) {
    const known = activeProfiles.map((item) => item.id).join(", ");
    throw new TypeError(`Unknown provider profile ${id}; expected one of: ${known}`);
  }
  return profile;
}

export function listProviderProfiles(): readonly ProviderProfile[] {
  return activeProfiles;
}

export function getProviderModelProfile(
  profile: ProviderProfile,
  model: string,
): ProviderModelProfile | undefined {
  return profile.models?.find((candidate) => candidate.id === model);
}

/** Resolve the effective wire API for a model; model catalog overrides the profile default. */
export function resolveProviderWireApi(profile: ProviderProfile, model: string): ProviderWireApi {
  return getProviderModelProfile(profile, model)?.wireApi ?? profile.wireApi;
}

/** Merge model wire hints over profile wire hints. */
export function resolveProviderWireHints(
  profile: ProviderProfile,
  model: string,
): ProviderWireHints {
  const modelWire = getProviderModelProfile(profile, model)?.wire;
  return {
    ...(profile.wire ?? {}),
    ...(modelWire ?? {}),
  };
}

export function providerModelContextTokens(profile: ProviderProfile, model: string): number {
  return getProviderModelProfile(profile, model)?.contextTokens ?? profile.contextTokens;
}

/** Optional model-catalog output reserve; undefined means the composition root keeps its default. */
export function providerModelOutputReserveTokens(
  profile: ProviderProfile,
  model: string,
): number | undefined {
  return getProviderModelProfile(profile, model)?.outputReserveTokens ?? profile.outputReserveTokens;
}

export function classifyProfileEndpoint(
  profile: ProviderProfile,
  baseURL: string,
): "official" | "custom" {
  const host = new URL(baseURL).hostname.toLowerCase();
  return profile.officialHosts.some((official) => official.toLowerCase() === host) ? "official" : "custom";
}

/** Whether thinking UI may advertise `none` for this model. */
export function thinkingAllowsDisable(thinking: ProviderModelThinking | undefined): boolean {
  if (!thinking) return false;
  if (thinking.mode === "always") return false;
  if (thinking.mode === "toggle") return thinking.allowDisable !== false;
  return thinking.allowDisable === true;
}

/** Intersect profile transport capabilities with operator/adapter narrowing into ModelCapabilities. */
export function modelCapabilitiesFromProfile(
  profile: ProviderProfile,
  narrowing: Partial<{
    model: string;
    contextTokens: number;
    toolCalls: boolean;
    reasoning: boolean;
    imageInput: boolean;
  }> = {},
): ModelCapabilities {
  const toolCalls = narrowing.toolCalls ?? profile.capabilities.toolCalls;
  const modelProfile = narrowing.model === undefined
    ? undefined
    : getProviderModelProfile(profile, narrowing.model);
  const reasoning = narrowing.reasoning ?? (Boolean(modelProfile?.thinking) || profile.capabilities.reasoning);
  const output = new Set<"text" | "reasoning" | "action">(["text"]);
  if (reasoning) output.add("reasoning");
  if (toolCalls) output.add("action");
  const input = new Set<"text" | "image" | "artifact">(["text"]);
  const profileImageInput = (modelProfile?.inputModalities ?? profile.inputModalities)?.includes("image") ?? false;
  if (narrowing.imageInput ?? profileImageInput) input.add("image");
  const wireApi = narrowing.model === undefined
    ? profile.wireApi
    : resolveProviderWireApi(profile, narrowing.model);
  const parallelActions = modelProfile?.parallelToolCalls ?? toolCalls;
  return {
    input,
    output,
    contextTokens: narrowing.contextTokens ?? modelProfile?.contextTokens ?? profile.contextTokens,
    parallelActions,
    promptCache: wireApi === "responses",
  };
}

export function assertProfileSupportsRequest(
  profile: ProviderProfile,
  options: { toolCount: number; needsReasoning?: boolean; model?: string },
): void {
  if (!profile.capabilities.streaming) {
    throw new TypeError(`Provider profile ${profile.id} does not support streaming`);
  }
  if (options.toolCount > 0 && !profile.capabilities.toolCalls) {
    throw new TypeError(`Provider profile ${profile.id} does not support tool calls`);
  }
  if (options.needsReasoning && !profile.capabilities.reasoning) {
    throw new TypeError(`Provider profile ${profile.id} does not support reasoning output`);
  }
  const wireApi = options.model === undefined
    ? profile.wireApi
    : resolveProviderWireApi(profile, options.model);
  if (wireApi === "responses" && !profile.capabilities.responses) {
    throw new TypeError(`Provider profile ${profile.id} is not configured for the Responses wire API`);
  }
  if (wireApi === "chat.completions" && !profile.capabilities.chatCompletions) {
    throw new TypeError(`Provider profile ${profile.id} is not configured for Chat Completions`);
  }
}
