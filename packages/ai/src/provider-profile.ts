import type { ModelCapabilities } from "./model.js";

/** Wire protocol selected by an explicit profile — never inferred from failed requests. */
export type ProviderWireApi = "responses" | "chat.completions";

export type ProviderAuthScheme = "api-key" | "oauth-device";

export interface ProviderTransportCapabilities {
  readonly chatCompletions: boolean;
  readonly responses: boolean;
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly reasoning: boolean;
  readonly usage: boolean;
  readonly requestMetadata: boolean;
}

export type ProviderThinkingEffort = "low" | "high" | "max";

export interface ProviderModelThinking {
  readonly mode: "toggle" | "effort";
  readonly supportedEfforts?: readonly ProviderThinkingEffort[];
  readonly defaultEffort?: ProviderThinkingEffort;
}

export interface ProviderModelProfile {
  readonly id: string;
  readonly displayName: string;
  readonly contextTokens: number;
  readonly inputModalities?: readonly ("text" | "image")[];
  readonly thinking?: ProviderModelThinking;
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
  /** Environment variable preferred for official API-key auth. */
  readonly envApiKey?: string;
  readonly envBaseURL?: string;
  readonly envModel?: string;
}

const responsesCaps = {
  chatCompletions: false,
  responses: true,
  streaming: true,
  toolCalls: true,
  reasoning: true,
  usage: true,
  requestMetadata: true,
} as const satisfies ProviderTransportCapabilities;

const chatCaps = {
  chatCompletions: true,
  responses: false,
  streaming: true,
  toolCalls: true,
  reasoning: false,
  usage: true,
  requestMetadata: false,
} as const satisfies ProviderTransportCapabilities;

export const BUILTIN_PROVIDER_PROFILES: readonly ProviderProfile[] = Object.freeze([
  {
    id: "openai",
    displayName: "OpenAI",
    wireApi: "responses",
    officialBaseURL: "https://api.openai.com/v1",
    officialHosts: ["api.openai.com"],
    authSchemes: ["api-key"],
    defaultModel: "gpt-5.4-mini",
    contextTokens: 128_000,
    inputModalities: ["text", "image"],
    capabilities: { ...responsesCaps },
    envApiKey: "OPENAI_API_KEY",
    envBaseURL: "OPENAI_BASE_URL",
  },
  {
    id: "xai",
    displayName: "xAI",
    wireApi: "responses",
    officialBaseURL: "https://api.x.ai/v1",
    officialHosts: ["api.x.ai"],
    authSchemes: ["api-key"],
    defaultModel: "grok-4.5",
    contextTokens: 256_000,
    capabilities: { ...responsesCaps, requestMetadata: false },
    envApiKey: "XAI_API_KEY",
    envBaseURL: "XAI_BASE_URL",
    envModel: "XAI_MODEL",
  },
  {
    id: "kimi",
    displayName: "Kimi Code",
    wireApi: "chat.completions",
    officialBaseURL: "https://api.kimi.com/coding/v1",
    officialHosts: ["api.kimi.com"],
    authSchemes: ["oauth-device", "api-key"],
    defaultModel: "k3",
    contextTokens: 1_048_576,
    models: [
      {
        id: "k3",
        displayName: "Kimi K3",
        contextTokens: 1_048_576,
        inputModalities: ["text", "image"],
        thinking: {
          mode: "effort",
          supportedEfforts: ["max"],
          defaultEffort: "max",
        },
      },
      {
        id: "k3-256k",
        displayName: "Kimi K3 256K",
        contextTokens: 262_144,
        inputModalities: ["text", "image"],
        thinking: {
          mode: "effort",
          supportedEfforts: ["max"],
          defaultEffort: "max",
        },
      },
      {
        id: "kimi-for-coding",
        displayName: "Kimi K2.7 Code",
        contextTokens: 262_144,
        inputModalities: ["text", "image"],
        thinking: { mode: "toggle" },
      },
      {
        id: "kimi-for-coding-highspeed",
        displayName: "Kimi K2.7 Code HighSpeed",
        contextTokens: 262_144,
        inputModalities: ["text", "image"],
        thinking: { mode: "toggle" },
      },
    ],
    capabilities: { ...chatCaps, reasoning: true },
    envApiKey: "KIMI_API_KEY",
    envBaseURL: "KIMI_BASE_URL",
    envModel: "KIMI_MODEL",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    wireApi: "chat.completions",
    officialBaseURL: "https://api.deepseek.com/v1",
    officialHosts: ["api.deepseek.com"],
    authSchemes: ["api-key"],
    defaultModel: "deepseek-v4-flash",
    contextTokens: 128_000,
    capabilities: { ...chatCaps },
    envApiKey: "DEEPSEEK_API_KEY",
    envBaseURL: "DEEPSEEK_BASE_URL",
    envModel: "DEEPSEEK_MODEL",
  },
  {
    id: "moonshot",
    displayName: "Moonshot",
    wireApi: "chat.completions",
    officialBaseURL: "https://api.moonshot.cn/v1",
    officialHosts: ["api.moonshot.cn"],
    authSchemes: ["api-key"],
    defaultModel: "moonshot-v1-128k",
    contextTokens: 128_000,
    capabilities: { ...chatCaps },
    envApiKey: "MOONSHOT_API_KEY",
    envBaseURL: "MOONSHOT_BASE_URL",
    envModel: "MOONSHOT_MODEL",
  },
  {
    id: "compatible",
    displayName: "OpenAI Compatible",
    wireApi: "chat.completions",
    officialBaseURL: "https://api.openai.com/v1",
    // Empty hosts → any endpoint is treated as custom; login form supplies name + key + URL + model.
    // Wire protocol stays OpenAI Chat Completions; `name` (account alias) labels gateways such as
    // qianwenai / zhipu without inventing a new provider profile.
    officialHosts: [],
    authSchemes: ["api-key"],
    defaultModel: "gpt-4o-mini",
    contextTokens: 128_000,
    capabilities: { ...chatCaps },
    envBaseURL: "QI_BASE_URL",
    envModel: "QI_MODEL",
  },
]);

const profileById = new Map(BUILTIN_PROVIDER_PROFILES.map((profile) => [profile.id, profile]));

export function getProviderProfile(id: string): ProviderProfile | undefined {
  return profileById.get(id);
}

export function requireProviderProfile(id: string): ProviderProfile {
  const profile = getProviderProfile(id);
  if (!profile) {
    const known = BUILTIN_PROVIDER_PROFILES.map((item) => item.id).join(", ");
    throw new TypeError(`Unknown provider profile ${id}; expected one of: ${known}`);
  }
  return profile;
}

export function listProviderProfiles(): readonly ProviderProfile[] {
  return BUILTIN_PROVIDER_PROFILES;
}

export function getProviderModelProfile(
  profile: ProviderProfile,
  model: string,
): ProviderModelProfile | undefined {
  return profile.models?.find((candidate) => candidate.id === model);
}

export function providerModelContextTokens(profile: ProviderProfile, model: string): number {
  return getProviderModelProfile(profile, model)?.contextTokens ?? profile.contextTokens;
}

export function classifyProfileEndpoint(
  profile: ProviderProfile,
  baseURL: string,
): "official" | "custom" {
  const host = new URL(baseURL).hostname.toLowerCase();
  return profile.officialHosts.some((official) => official.toLowerCase() === host) ? "official" : "custom";
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
  return {
    input,
    output,
    contextTokens: narrowing.contextTokens ?? modelProfile?.contextTokens ?? profile.contextTokens,
    parallelActions: toolCalls,
    promptCache: profile.wireApi === "responses",
  };
}

export function assertProfileSupportsRequest(
  profile: ProviderProfile,
  options: { toolCount: number; needsReasoning?: boolean },
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
  if (profile.wireApi === "responses" && !profile.capabilities.responses) {
    throw new TypeError(`Provider profile ${profile.id} is not configured for the Responses wire API`);
  }
  if (profile.wireApi === "chat.completions" && !profile.capabilities.chatCompletions) {
    throw new TypeError(`Provider profile ${profile.id} is not configured for Chat Completions`);
  }
}
