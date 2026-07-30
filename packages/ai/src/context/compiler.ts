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
    return Math.max(1, Math.ceil([...text].length / 4));
  },
};

export interface CompileContextInput {
  blocks: readonly ContextBlock[];
  budgetTokens: number;
  estimator?: TokenEstimator;
}

export function compileContext(input: CompileContextInput): CompiledContext {
  if (!Number.isInteger(input.budgetTokens) || input.budgetTokens <= 0) {
    throw new RangeError("budgetTokens must be a positive integer");
  }
  const estimator = input.estimator ?? approximateTokenEstimator;
  const ids = new Set<string>();
  const estimated = input.blocks.map((block, index) => {
    if (!block.id) throw new TypeError(`Context block at index ${index} has no id`);
    if (ids.has(block.id)) throw new TypeError(`Duplicate context block id: ${block.id}`);
    if (!Number.isFinite(block.priority)) throw new TypeError(`Context block ${block.id} has invalid priority`);
    ids.add(block.id);
    return { ...block, estimatedTokens: estimator.estimate(block.content), index };
  });

  const requiredTokens = estimated
    .filter((block) => block.required)
    .reduce((total, block) => total + block.estimatedTokens, 0);
  if (requiredTokens > input.budgetTokens) {
    throw new ContextBudgetError(requiredTokens, input.budgetTokens);
  }

  const selected = new Set(estimated.filter((block) => block.required).map((block) => block.id));
  let used = requiredTokens;
  const optional = estimated
    .filter((block) => !block.required)
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
