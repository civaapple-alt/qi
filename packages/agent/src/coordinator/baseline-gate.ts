export interface PairedAgentTrial {
  evalId: string;
  budget: number;
  single: { passed: boolean; resourceUsed: number; contextTokens: number; wallTimeMs: number };
  multi: { passed: boolean; resourceUsed: number; contextTokens: number; wallTimeMs: number; coordinationWallTimeMs: number };
}

export interface MultiAgentGateDecision {
  enabledByDefault: boolean;
  reason: string;
  trials: number;
  singlePassRate: number;
  multiPassRate: number;
  singleMeanContextTokens: number;
  multiMeanContextTokens: number;
  coordinationMeanWallTimeMs: number;
}

export class MultiAgentBaselineGate {
  readonly #minimumTrials: number;
  readonly #trials: PairedAgentTrial[] = [];

  constructor(minimumTrials = 3) {
    if (!Number.isInteger(minimumTrials) || minimumTrials < 1) throw new RangeError("minimumTrials must be positive");
    this.#minimumTrials = minimumTrials;
  }

  record(trial: PairedAgentTrial): void {
    if (!trial.evalId || !Number.isFinite(trial.budget) || trial.budget <= 0) throw new TypeError("Trial requires an eval and positive shared budget");
    for (const value of [trial.single.resourceUsed, trial.multi.resourceUsed, trial.single.contextTokens, trial.single.wallTimeMs, trial.multi.contextTokens, trial.multi.wallTimeMs, trial.multi.coordinationWallTimeMs]) {
      if (!Number.isFinite(value) || value < 0) throw new TypeError("Trial measurements must be finite and non-negative");
    }
    if (trial.single.resourceUsed > trial.budget || trial.multi.resourceUsed > trial.budget) {
      throw new RangeError("Both arms must stay within the paired trial budget");
    }
    this.#trials.push(structuredClone(trial));
  }

  decision(evalId: string): MultiAgentGateDecision {
    const trials = this.#trials.filter((trial) => trial.evalId === evalId);
    const count = trials.length;
    const singlePassRate = mean(trials.map((trial) => Number(trial.single.passed)));
    const multiPassRate = mean(trials.map((trial) => Number(trial.multi.passed)));
    const singleMeanContextTokens = mean(trials.map((trial) => trial.single.contextTokens));
    const multiMeanContextTokens = mean(trials.map((trial) => trial.multi.contextTokens));
    const coordinationMeanWallTimeMs = mean(trials.map((trial) => trial.multi.coordinationWallTimeMs));
    const successImproved = multiPassRate > singlePassRate;
    const contextImprovedWithoutRegression = multiPassRate >= singlePassRate && multiMeanContextTokens < singleMeanContextTokens;
    const enabledByDefault = count >= this.#minimumTrials && (successImproved || contextImprovedWithoutRegression);
    return {
      enabledByDefault,
      reason: count < this.#minimumTrials
        ? `Need ${this.#minimumTrials - count} more paired trial(s)`
        : enabledByDefault ? "Multi-Agent improved the target eval under the same declared budget" : "No measured advantage over the single-Agent baseline",
      trials: count,
      singlePassRate,
      multiPassRate,
      singleMeanContextTokens,
      multiMeanContextTokens,
      coordinationMeanWallTimeMs,
    };
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
