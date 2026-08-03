import type { ModelMessage } from "@civaapple/qi-ai";

export type ContextKind =
  | "constitution"
  | "control"
  | "goal"
  | "workspace"
  | "memory"
  | "skill"
  | "recent"
  | "tool-catalog"
  | "evaluation";

export interface ContextBlock {
  id: string;
  kind: ContextKind;
  source: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  priority: number;
  required: boolean;
  retentionReason: string;
}

export interface EstimatedContextBlock extends ContextBlock {
  estimatedTokens: number;
}

export interface ContextBlockStats {
  kind: ContextKind;
  includedCount: number;
  includedEstimatedTokens: number;
  omittedCount: number;
  omittedEstimatedTokens: number;
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export interface CompiledContext {
  messages: ModelMessage[];
  included: EstimatedContextBlock[];
  omitted: EstimatedContextBlock[];
  blockStats: ContextBlockStats[];
  estimatedTokens: number;
  budgetTokens: number;
}

export class ContextBudgetError extends Error {
  readonly requiredTokens: number;
  readonly budgetTokens: number;

  constructor(requiredTokens: number, budgetTokens: number) {
    super(`Required context needs ${requiredTokens} tokens, exceeding budget ${budgetTokens}`);
    this.name = "ContextBudgetError";
    this.requiredTokens = requiredTokens;
    this.budgetTokens = budgetTokens;
  }
}

export const approximateTokenEstimator: TokenEstimator = {
  estimate(text: string): number {
    let ascii = 0;
    let nonAscii = 0;
    for (const character of text) {
      if (character.codePointAt(0)! <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
    // Provider tokenizers vary. ASCII prose/code commonly averages near four
    // characters per token, while CJK and other Unicode may consume one or
    // more tokens per code point. Two tokens is intentionally conservative.
    return Math.max(1, Math.ceil(ascii / 4) + nonAscii * 2);
  },
};

export function estimateSerializedTokens(
  value: unknown,
  estimator: TokenEstimator = approximateTokenEstimator,
  framingTokens = 0,
): number {
  if (!Number.isInteger(framingTokens) || framingTokens < 0) {
    throw new RangeError("framingTokens must be a non-negative integer");
  }
  const estimated = estimator.estimate(JSON.stringify(value));
  if (!Number.isSafeInteger(estimated) || estimated <= 0) {
    throw new TypeError("Token estimator returned an invalid serialized value");
  }
  return estimated + framingTokens;
}

export interface CompileContextInput {
  blocks: readonly ContextBlock[];
  budgetTokens: number;
  estimator?: TokenEstimator;
  /**
   * Optional block IDs that must stay included when present (Run-scoped freeze).
   * Unknown IDs are ignored. Pinned blocks count against the budget like required blocks.
   */
  pinnedOptionalIds?: readonly string[];
}

export function compileContext(input: CompileContextInput): CompiledContext {
  if (!Number.isInteger(input.budgetTokens) || input.budgetTokens <= 0) {
    throw new RangeError("budgetTokens must be a positive integer");
  }
  const estimator = input.estimator ?? approximateTokenEstimator;
  const pinnedOptionalIds = new Set(input.pinnedOptionalIds ?? []);
  const ids = new Set<string>();
  const estimated = input.blocks.map((block, index) => {
    if (!block.id) throw new TypeError(`Context block at index ${index} has no id`);
    if (ids.has(block.id)) throw new TypeError(`Duplicate context block id: ${block.id}`);
    if (!Number.isFinite(block.priority)) throw new TypeError(`Context block ${block.id} has invalid priority`);
    ids.add(block.id);
    const estimatedTokens = estimator.estimate(block.content);
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens <= 0) {
      throw new TypeError(`Token estimator returned an invalid value for Context block ${block.id}`);
    }
    return { ...block, estimatedTokens, index };
  });

  const forced = estimated.filter((block) => block.required || pinnedOptionalIds.has(block.id));
  const forcedTokens = forced.reduce((total, block) => total + block.estimatedTokens, 0);
  if (forcedTokens > input.budgetTokens) {
    throw new ContextBudgetError(forcedTokens, input.budgetTokens);
  }

  const selected = new Set(forced.map((block) => block.id));
  let used = forcedTokens;
  const optional = estimated
    .filter((block) => !selected.has(block.id))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);

  for (const block of optional) {
    if (used + block.estimatedTokens > input.budgetTokens) continue;
    selected.add(block.id);
    used += block.estimatedTokens;
  }

  const included = estimated.filter((block) => selected.has(block.id));
  const omitted = estimated.filter((block) => !selected.has(block.id));
  const statsByKind = new Map<ContextKind, ContextBlockStats>();
  for (const block of estimated) {
    const stats = statsByKind.get(block.kind) ?? {
      kind: block.kind,
      includedCount: 0,
      includedEstimatedTokens: 0,
      omittedCount: 0,
      omittedEstimatedTokens: 0,
    };
    if (selected.has(block.id)) {
      stats.includedCount += 1;
      stats.includedEstimatedTokens += block.estimatedTokens;
    } else {
      stats.omittedCount += 1;
      stats.omittedEstimatedTokens += block.estimatedTokens;
    }
    statsByKind.set(block.kind, stats);
  }

  return {
    messages: included.map((block) => ({
      role: block.role,
      content: [{ type: "text", text: block.content }],
    })),
    included: included.map(({ index: _, ...block }) => block),
    omitted: omitted.map(({ index: _, ...block }) => block),
    blockStats: [...statsByKind.values()],
    estimatedTokens: used,
    budgetTokens: input.budgetTokens,
  };
}
