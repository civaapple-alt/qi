import {
  classifyProfileEndpoint,
  getProviderProfile,
  listProviderProfiles,
  normalizeReasoningEffort,
  requireProviderProfile,
  resolveProviderWireApi,
  type ProviderThinkingEffort,
  type ProviderProfile,
} from "@civaapple/qi-ai";

export type QiProvider = string;

export interface ProviderEnvironment {
  readonly QI_PROVIDER?: string;
  readonly QI_MODEL?: string;
  readonly QI_REASONING_EFFORT?: string;
  readonly QI_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly XAI_API_KEY?: string;
  readonly XAI_BASE_URL?: string;
  readonly XAI_MODEL?: string;
  readonly KIMI_API_KEY?: string;
  readonly KIMI_BASE_URL?: string;
  readonly KIMI_MODEL?: string;
  readonly KIMI_MODEL_THINKING_EFFORT?: string;
  readonly DEEPSEEK_API_KEY?: string;
  readonly DEEPSEEK_BASE_URL?: string;
  readonly DEEPSEEK_MODEL?: string;
  readonly MOONSHOT_API_KEY?: string;
  readonly MOONSHOT_BASE_URL?: string;
  readonly MOONSHOT_MODEL?: string;
  readonly QI_BASE_URL?: string;
}

export interface ResolveProviderConfigInput {
  readonly provider?: string;
  readonly model?: string;
  readonly baseURL?: string;
  readonly reasoningEffort?: string;
  readonly accountAlias?: string;
  readonly imageInput?: boolean;
  readonly defaults?: {
    readonly provider?: string;
    readonly model?: string;
    readonly baseURL?: string;
    readonly reasoningEffort?: string;
    readonly accountAlias?: string;
    readonly imageInput?: boolean;
  };
  readonly environment?: ProviderEnvironment | NodeJS.ProcessEnv;
  /** When true, missing credentials become authStatus=missing instead of throwing. */
  readonly allowMissingCredential?: boolean;
}

export interface ProviderConfig {
  readonly provider: QiProvider;
  readonly model: string;
  readonly reasoningEffort?: ProviderThinkingEffort | "none";
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly endpointTrust: "official" | "custom";
  readonly profile: ProviderProfile;
  readonly accountAlias: string;
  readonly authStatus: "ready" | "missing";
  readonly wireApi: ProviderProfile["wireApi"];
  readonly imageInput?: boolean;
}

export function resolveProviderConfig(input: ResolveProviderConfigInput = {}): ProviderConfig {
  const environment = input.environment ?? process.env;
  const requestedProvider = optionalValue(input.provider) ??
    optionalValue(environment.QI_PROVIDER) ??
    optionalValue(input.defaults?.provider);
  const provider = selectProvider(requestedProvider, environment);
  const profile = requireProviderProfile(provider);
  const matchingDefaults = input.defaults?.provider === provider ? input.defaults : undefined;
  const accountAlias = optionalValue(input.accountAlias) ??
    optionalValue(matchingDefaults?.accountAlias) ??
    "default";

  const configuredBaseURL = optionalValue(input.baseURL) ??
    optionalEnv(environment, profile.envBaseURL) ??
    optionalValue(matchingDefaults?.baseURL);
  const baseURL = configuredBaseURL === undefined
    ? profile.officialBaseURL
    : validateBaseURL(configuredBaseURL, `${profile.displayName} base URL`);
  const endpointTrust = classifyProfileEndpoint(profile, baseURL);

  if (provider === "xai" && new URL(baseURL).hostname.toLowerCase() === "api.openai.com") {
    throw new TypeError(
      "XAI_BASE_URL points to api.openai.com; use https://api.x.ai/v1 for xAI or select --provider openai",
    );
  }

  const apiKey = resolveCredential({
    profile,
    endpointTrust,
    environment,
    allowMissing: input.allowMissingCredential === true,
  });

  const model = optionalValue(input.model) ??
    optionalValue(environment.QI_MODEL) ??
    optionalEnv(environment, profile.envModel) ??
    optionalValue(matchingDefaults?.model) ??
    profile.defaultModel;

  if (!model) {
    throw new TypeError(`${profile.displayName} requires ${profile.envModel ?? "QI_MODEL"} or --model`);
  }
  const supportsReasoningEffort = provider === "kimi" || provider === "deepseek";
  const requestedReasoningEffort = optionalValue(input.reasoningEffort) ??
    optionalValue(environment.QI_REASONING_EFFORT) ??
    (provider === "kimi" ? optionalValue(environment.KIMI_MODEL_THINKING_EFFORT) : undefined) ??
    optionalValue(matchingDefaults?.reasoningEffort);
  if (requestedReasoningEffort !== undefined && !supportsReasoningEffort) {
    throw new TypeError("reasoning effort is currently supported only by the Kimi and DeepSeek providers");
  }
  const normalizedReasoningEffort = supportsReasoningEffort
    ? normalizeReasoningEffort(requestedReasoningEffort)
    : undefined;
  const reasoningEffort = provider === "kimi" && (model === "k3" || model === "k3-256k") &&
      normalizedReasoningEffort !== undefined && normalizedReasoningEffort !== "none"
    ? "max"
    : normalizedReasoningEffort;
  const imageInput = provider === "compatible"
    ? input.imageInput ?? matchingDefaults?.imageInput
    : undefined;

  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(apiKey === undefined ? {} : { apiKey }),
    baseURL,
    endpointTrust,
    profile,
    accountAlias,
    authStatus: apiKey ? "ready" : "missing",
    wireApi: resolveProviderWireApi(profile, model),
    ...(imageInput === undefined ? {} : { imageInput }),
  };
}

function selectProvider(
  requested: string | undefined,
  environment: ProviderEnvironment,
): string {
  if (requested !== undefined) {
    if (!getProviderProfile(requested)) {
      const known = listProviderProfiles().map((profile) => profile.id).join(", ");
      throw new TypeError(`Unsupported provider ${requested}; expected one of: ${known}`);
    }
    return requested;
  }

  const present = listProviderProfiles()
    .filter((profile) => profile.envApiKey && optionalEnv(environment, profile.envApiKey))
    .map((profile) => profile.id);
  if (present.length > 1) {
    throw new TypeError(
      `Multiple provider API keys are set (${present.join(", ")}); choose QI_PROVIDER or --provider`,
    );
  }
  if (present.length === 1) return present[0]!;
  return "openai";
}

function resolveCredential(options: {
  profile: ProviderProfile;
  endpointTrust: "official" | "custom";
  environment: ProviderEnvironment;
  allowMissing: boolean;
}): string | undefined {
  const official = optionalEnv(options.environment, options.profile.envApiKey);
  const custom = optionalValue(options.environment.QI_API_KEY);

  if (options.endpointTrust === "custom") {
    if (official && !custom) {
      throw new TypeError(
        `Custom ${options.profile.displayName} endpoint requires QI_API_KEY; refusing to send ${options.profile.envApiKey} to a non-official host`,
      );
    }
    if (custom) return custom;
    if (options.allowMissing) return undefined;
    throw new TypeError(`Custom ${options.profile.displayName} endpoint requires QI_API_KEY`);
  }

  if (official) return official;
  if (custom) return custom;
  if (options.allowMissing) return undefined;
  const expected = options.profile.envApiKey ?? "QI_API_KEY";
  throw new TypeError(`${options.profile.displayName} requires ${expected} or QI_API_KEY`);
}

function optionalEnv(
  environment: ProviderEnvironment,
  name: string | undefined,
): string | undefined {
  if (!name) return undefined;
  return optionalValue((environment as Record<string, string | undefined>)[name]);
}

export function validateProviderBaseURL(value: string, label = "base URL"): string {
  return validateBaseURL(value, label);
}

function validateBaseURL(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`${label} must be an http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not embed credentials in the URL`);
  }
  return value.replace(/\/+$/, "");
}

function optionalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export { formatProviderLabel } from "@civaapple/qi-tui";

/** Normalize a login/display name into an account alias stored in config / sealed credentials. */
export function normalizeAccountAlias(value: string | undefined, fallback = "default"): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed) return fallback;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new TypeError(
      `Invalid name "${value}"; use letters, digits, ".", "_", or "-" (max 64, start with alphanumeric)`,
    );
  }
  return trimmed;
}
