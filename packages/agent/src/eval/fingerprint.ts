import { createHash } from "node:crypto";

export interface FailureFingerprintInput {
  assertionId: string;
  evaluatorIdentity: string;
  errorCode: string;
  stackFrames?: readonly string[];
  targetResources: readonly string[];
}

export function failureFingerprint(input: FailureFingerprintInput): string {
  const canonical = JSON.stringify({
    assertionId: normalize(input.assertionId),
    evaluatorIdentity: normalize(input.evaluatorIdentity),
    errorCode: normalizeNoise(input.errorCode),
    stackFrames: [...new Set((input.stackFrames ?? []).map(normalizeFrame).filter(Boolean))].sort(),
    targetResources: [...new Set(input.targetResources.map(normalize))].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("\\", "/");
}

function normalizeNoise(value: string): string {
  return normalize(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gi, "<timestamp>")
    .replace(/\b(?:evt|run|stp|act|evl|evi)_[a-z0-9_-]+\b/gi, "<id>");
}

function normalizeFrame(frame: string): string {
  return normalizeNoise(frame).replace(/:\d+(?::\d+)?(?=\)?$)/, ":<line>");
}
