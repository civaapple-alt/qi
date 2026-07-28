import { createHash } from "node:crypto";

export interface SemanticEvaluatorIdentity {
  kind: "semantic";
  model: string;
  prompt: string;
  rubric: string;
  toolchain: string;
  version: string;
}

export interface CalibrationReport {
  truePass: number;
  trueReject: number;
  falsePass: number;
  falseReject: number;
  validUntil: string;
  measuredAt: string;
}

export interface CalibrationPolicy {
  minimumSamples: number;
  maximumFalsePassRate: number;
  maximumFalseRejectRate: number;
}

export interface CalibrationStatus {
  identity: string;
  trusted: boolean;
  samples: number;
  falsePassRate: number;
  falseRejectRate: number;
  reason: string;
}

const defaultPolicy: CalibrationPolicy = {
  minimumSamples: 30,
  maximumFalsePassRate: 0.05,
  maximumFalseRejectRate: 0.15,
};

export class EvaluatorCalibrationRegistry {
  readonly #reports = new Map<string, CalibrationReport>();
  readonly #policy: CalibrationPolicy;

  constructor(policy: CalibrationPolicy = defaultPolicy) {
    validatePolicy(policy);
    this.#policy = { ...policy };
  }

  record(identity: SemanticEvaluatorIdentity, report: CalibrationReport): string {
    validateReport(report);
    const key = evaluatorIdentity(identity);
    this.#reports.set(key, structuredClone(report));
    return key;
  }

  status(identity: SemanticEvaluatorIdentity, now = new Date()): CalibrationStatus {
    const key = evaluatorIdentity(identity);
    const report = this.#reports.get(key);
    if (!report) return untrusted(key, "No calibration report exists");
    const samples = report.truePass + report.trueReject + report.falsePass + report.falseReject;
    const passDenominator = report.falsePass + report.trueReject;
    const rejectDenominator = report.falseReject + report.truePass;
    const falsePassRate = passDenominator === 0 ? 0 : report.falsePass / passDenominator;
    const falseRejectRate = rejectDenominator === 0 ? 0 : report.falseReject / rejectDenominator;
    let reason = "Calibration is within policy";
    let trusted = true;
    if (samples < this.#policy.minimumSamples) {
      trusted = false;
      reason = `Calibration has ${samples}/${this.#policy.minimumSamples} required samples`;
    } else if (Date.parse(report.validUntil) <= now.getTime()) {
      trusted = false;
      reason = `Calibration expired at ${report.validUntil}`;
    } else if (falsePassRate > this.#policy.maximumFalsePassRate) {
      trusted = false;
      reason = `False-pass rate ${falsePassRate} exceeds ${this.#policy.maximumFalsePassRate}`;
    } else if (falseRejectRate > this.#policy.maximumFalseRejectRate) {
      trusted = false;
      reason = `False-reject rate ${falseRejectRate} exceeds ${this.#policy.maximumFalseRejectRate}`;
    }
    return { identity: key, trusted, samples, falsePassRate, falseRejectRate, reason };
  }
}

export function evaluatorIdentity(identity: SemanticEvaluatorIdentity): string {
  const canonical = JSON.stringify({
    kind: identity.kind,
    model: identity.model,
    prompt: identity.prompt,
    rubric: identity.rubric,
    toolchain: identity.toolchain,
    version: identity.version,
  });
  return `semantic:${createHash("sha256").update(canonical).digest("hex")}`;
}

function untrusted(identity: string, reason: string): CalibrationStatus {
  return { identity, trusted: false, samples: 0, falsePassRate: 0, falseRejectRate: 0, reason };
}

function validatePolicy(policy: CalibrationPolicy): void {
  if (!Number.isInteger(policy.minimumSamples) || policy.minimumSamples <= 0) throw new RangeError("minimumSamples must be positive");
  for (const [name, value] of Object.entries(policy)) {
    if (name === "minimumSamples") continue;
    if (typeof value !== "number" || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function validateReport(report: CalibrationReport): void {
  for (const name of ["truePass", "trueReject", "falsePass", "falseReject"] as const) {
    if (!Number.isInteger(report[name]) || report[name] < 0) throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (!Number.isFinite(Date.parse(report.validUntil)) || !Number.isFinite(Date.parse(report.measuredAt))) {
    throw new TypeError("Calibration timestamps must be valid ISO timestamps");
  }
}
