import type { SemanticEvaluatorIdentity } from "./calibration.js";

export type EvalOutcome = "pass" | "fail" | "unknown";

export interface EvalDraft {
  outcome: EvalOutcome;
  evidenceRefs: readonly string[];
  reproducible: boolean;
  confidence?: number;
}

export interface Evaluator<Input> {
  readonly kind: "deterministic" | "semantic" | "human";
  readonly version: string;
  evaluate(input: Input, signal?: AbortSignal): Promise<EvalDraft>;
}

export class DeterministicEvaluator<Input> implements Evaluator<Input> {
  readonly kind = "deterministic" as const;
  readonly version: string;
  readonly #evaluate: (input: Input, signal?: AbortSignal) => EvalDraft | Promise<EvalDraft>;

  constructor(version: string, evaluate: (input: Input, signal?: AbortSignal) => EvalDraft | Promise<EvalDraft>) {
    if (!version) throw new TypeError("Evaluator version is required");
    this.version = version;
    this.#evaluate = evaluate;
  }

  async evaluate(input: Input, signal?: AbortSignal): Promise<EvalDraft> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Evaluation aborted", "AbortError");
    const result = await this.#evaluate(input, signal);
    validateDraft(result);
    return structuredClone(result);
  }
}

export class SemanticEvaluator<Input> implements Evaluator<Input> {
  readonly kind = "semantic" as const;
  readonly identity: SemanticEvaluatorIdentity;
  readonly version: string;
  readonly #evaluate: (input: Input, signal?: AbortSignal) => Promise<EvalDraft>;

  constructor(identity: SemanticEvaluatorIdentity, evaluate: (input: Input, signal?: AbortSignal) => Promise<EvalDraft>) {
    this.identity = structuredClone(identity);
    this.version = identity.version;
    this.#evaluate = evaluate;
  }

  async evaluate(input: Input, signal?: AbortSignal): Promise<EvalDraft> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Evaluation aborted", "AbortError");
    const result = await this.#evaluate(input, signal);
    validateDraft(result);
    return structuredClone(result);
  }
}

function validateDraft(draft: EvalDraft): void {
  if (!["pass", "fail", "unknown"].includes(draft.outcome)) throw new TypeError(`Invalid outcome ${draft.outcome}`);
  if (new Set(draft.evidenceRefs).size !== draft.evidenceRefs.length) throw new TypeError("Evidence references must be unique");
  if (draft.confidence !== undefined && (draft.confidence < 0 || draft.confidence > 1)) {
    throw new RangeError("confidence must be between 0 and 1");
  }
}
