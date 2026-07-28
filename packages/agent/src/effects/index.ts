import { createHash } from "node:crypto";

export type EffectStatus = "reserved" | "started" | "completed" | "failed" | "indeterminate";

export interface EffectRecord {
  idempotencyKey: string;
  intentHash: string;
  actionId: string;
  status: EffectStatus;
  attempts: number;
  output?: unknown;
  detail?: string;
  updatedAt: string;
}

export type BeginEffectResult =
  | { outcome: "acquired"; record: EffectRecord }
  | { outcome: "replay"; record: EffectRecord; output: unknown }
  | { outcome: "blocked"; record: EffectRecord; reason: string };

/** Persistence-neutral effect settlement port owned by the Agent lifecycle. */
export interface EffectJournal {
  begin(input: {
    idempotencyKey: string;
    intentHash: string;
    actionId: string;
    occurredAt?: string;
  }): BeginEffectResult;
  markStarted(idempotencyKey: string, occurredAt?: string): EffectRecord;
  complete(idempotencyKey: string, output: unknown, occurredAt?: string): EffectRecord;
  fail(idempotencyKey: string, detail: string, occurredAt?: string): EffectRecord;
  indeterminate(idempotencyKey: string, detail: string, occurredAt?: string): EffectRecord;
  reconcile(
    idempotencyKey: string,
    outcome: "completed" | "failed",
    detail: string,
    output?: unknown,
    occurredAt?: string,
  ): EffectRecord;
  get(idempotencyKey: string): EffectRecord | undefined;
}

export function effectIntentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function effectIdempotencyKey(
  scope: string,
  tool: string,
  input: unknown,
  resources: readonly string[],
): string {
  return `effect:${effectIntentHash({ scope, tool, input, resources: [...resources].sort() })}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) throw new TypeError("Value is not JSON-serializable");
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
