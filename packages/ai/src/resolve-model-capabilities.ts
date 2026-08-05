import {
  getProviderModelProfile,
  resolveProviderWireApi,
  resolveProviderWireHints,
  thinkingAllowsDisable,
  type ProviderProfile,
  type ProviderThinkingEffort,
  type ProviderWireApi,
  type ProviderWireHints,
} from "./provider-profile.js";
import { normalizeReasoningEffort } from "./thinking-wire.js";

export interface OperatorModelPreferences {
  readonly reasoningEffort?: string | null;
  readonly imageInput?: boolean;
  readonly contextWindowTokens?: number;
  readonly outputReserveTokens?: number;
}

export interface ResolvedModelCapabilities {
  readonly wireApi: ProviderWireApi;
  readonly wireHints: ProviderWireHints;
  /** Operator-facing / adapter context window. */
  readonly contextTokens: number;
  /** Context Compiler usable window after effective_context_window_percent. */
  readonly usableContextTokens: number;
  /** Catalog or global preferred reserve before hard cap (for UI). */
  readonly catalogOutputReserveTokens: number | undefined;
  /**
   * Effective max-output / output reserve after `min(preferred, floor(context/8))`.
   * When `operatorOutputReserve` and catalog are both unset, remains undefined so
   * composition roots can apply their own default (e.g. 16000) then cap.
   */
  readonly outputReserveTokens: number | undefined;
  readonly inputModalities: readonly ("text" | "image")[];
  readonly catalogAllowsImage: boolean;
  readonly imageInput: boolean;
  readonly thinkingMode: "none" | "toggle" | "effort" | "always";
  /** Effort values advertised in UI (may include `none`). */
  readonly effortsForUi: readonly (ProviderThinkingEffort | "none")[];
  readonly effectiveEffort: ProviderThinkingEffort | "none" | undefined;
  readonly effortLabels: Readonly<Partial<Record<ProviderThinkingEffort | "none", string>>>;
}

const DEFAULT_OUTPUT_RESERVE_FALLBACK = 16_000;

/** Cap output reserve at 1/8 of the window (same rule as CLI composition root). */
export function capOutputReserveTokens(
  contextWindowTokens: number,
  preferredReserveTokens: number,
): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 8_192) {
    throw new RangeError("contextWindowTokens must be an integer >= 8192");
  }
  if (!Number.isInteger(preferredReserveTokens) || preferredReserveTokens < 1) {
    throw new RangeError("preferredReserveTokens must be a positive integer");
  }
  return Math.min(preferredReserveTokens, Math.floor(contextWindowTokens / 8));
}

function resolveImageInputDefault(
  profile: ProviderProfile,
  catalogAllowsImage: boolean,
  modelDefault: boolean | undefined,
  profileDefault: boolean | undefined,
): boolean {
  if (!catalogAllowsImage) return false;
  if (modelDefault !== undefined) return modelDefault;
  if (profileDefault !== undefined) return profileDefault;
  // Official catalogs default on when images are supported; empty-host compatible stays off.
  return profile.officialHosts.length > 0;
}

/**
 * Single resolve path for context, output reserve, modalities, and thinking/effort.
 * CLI UI, routing, and adapters should consume this instead of ad-hoc profile.id branches.
 */
export function resolveModelCapabilities(
  profile: ProviderProfile,
  model: string,
  operator: OperatorModelPreferences = {},
): ResolvedModelCapabilities {
  const modelProfile = getProviderModelProfile(profile, model);
  const wireApi = resolveProviderWireApi(profile, model);
  const wireHints = resolveProviderWireHints(profile, model);

  const catalogContext = modelProfile?.contextTokens ?? profile.contextTokens;
  const contextTokens = operator.contextWindowTokens ?? catalogContext;
  if (!Number.isInteger(contextTokens) || contextTokens < 8_192) {
    throw new RangeError(`contextTokens must be an integer >= 8192 (got ${contextTokens})`);
  }
  const percent = modelProfile?.effectiveContextWindowPercent
    ?? profile.effectiveContextWindowPercent
    ?? 100;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new RangeError(`effectiveContextWindowPercent must be an integer 1..100 (got ${percent})`);
  }
  const usableContextTokens = Math.floor(contextTokens * percent / 100);

  const catalogReserve = modelProfile?.outputReserveTokens ?? profile.outputReserveTokens;
  const preferredReserve = operator.outputReserveTokens ?? catalogReserve;
  const outputReserveTokens = preferredReserve === undefined
    ? undefined
    : capOutputReserveTokens(contextTokens, preferredReserve);

  const inputModalities = modelProfile?.inputModalities
    ?? profile.inputModalities
    ?? (["text"] as const);
  const catalogAllowsImage = inputModalities.includes("image");
  const imageInputDefault = resolveImageInputDefault(
    profile,
    catalogAllowsImage,
    modelProfile?.imageInputDefault,
    profile.imageInputDefault,
  );
  const imageInput = catalogAllowsImage
    && (operator.imageInput ?? imageInputDefault);

  const thinking = modelProfile?.thinking;
  let thinkingMode: ResolvedModelCapabilities["thinkingMode"] = "none";
  let effortsForUi: readonly (ProviderThinkingEffort | "none")[] = [];
  let effectiveEffort: ProviderThinkingEffort | "none" | undefined;
  const effortLabels = thinking?.effortLabels ?? {};

  if (thinking) {
    thinkingMode = thinking.mode;
    const allowDisable = thinkingAllowsDisable(thinking);
    if (thinking.mode === "always") {
      effortsForUi = [];
      effectiveEffort = undefined;
    } else if (thinking.mode === "toggle") {
      const on = thinking.defaultEffort ?? thinking.supportedEfforts?.[0] ?? "high";
      effortsForUi = allowDisable ? ["none", on] : [on];
      const requested = normalizeReasoningEffort(operator.reasoningEffort);
      if (requested === "none") {
        // Wire may still disable; UI omits `none` when allowDisable is false.
        effectiveEffort = "none";
      } else if (requested !== undefined && (requested === on || thinking.supportedEfforts?.includes(requested))) {
        effectiveEffort = requested;
      } else {
        effectiveEffort = on;
      }
    } else {
      const supported = thinking.supportedEfforts ?? [];
      effortsForUi = allowDisable ? ["none", ...supported] : [...supported];
      const requested = normalizeReasoningEffort(operator.reasoningEffort);
      if (requested === "none") {
        effectiveEffort = "none";
      } else if (requested !== undefined && supported.includes(requested)) {
        effectiveEffort = requested;
      } else if (requested === "xhigh" && supported.includes("max")) {
        effectiveEffort = "max";
      } else if (requested === "max" && supported.includes("xhigh")) {
        effectiveEffort = "xhigh";
      } else if (requested === undefined) {
        // Unset → omit on wire; UI shows no configured effort (provider API default).
        effectiveEffort = undefined;
      } else {
        // Portable alias not in catalog → fall back to default (historic behavior).
        effectiveEffort = thinking.defaultEffort ?? supported[0] ?? requested;
      }
    }
  }

  return {
    wireApi,
    wireHints,
    contextTokens,
    usableContextTokens,
    catalogOutputReserveTokens: catalogReserve,
    outputReserveTokens,
    inputModalities,
    catalogAllowsImage,
    imageInput,
    thinkingMode,
    effortsForUi,
    effectiveEffort,
    effortLabels,
  };
}

/** Apply composition-root default (16000) then hard-cap — used when resolve left reserve unset. */
export function resolveOutputReserveWithDefault(
  contextWindowTokens: number,
  preferredReserveTokens?: number,
  fallback = DEFAULT_OUTPUT_RESERVE_FALLBACK,
): number {
  return capOutputReserveTokens(contextWindowTokens, preferredReserveTokens ?? fallback);
}
