export type SensitiveDataKind =
  | "authorization"
  | "provider-token"
  | "private-key"
  | "url-credential";

export interface RedactionSummary {
  readonly kind: SensitiveDataKind;
  readonly count: number;
}

export interface RedactionResult<T> {
  readonly value: T;
  readonly redactions: readonly RedactionSummary[];
}

const alreadyRedacted = /^\[REDACTED:[a-z-]+\]$/i;

/**
 * Removes extremely high-confidence credential literals without retaining the matched value.
 * Source-code assignment forms are intentionally left alone so authorized file reads can round-trip
 * into precise edit. Sensitive Workspace paths are gated by human grants instead (ADR-0001).
 *
 * `Authorization: Bearer` values are not rewritten: agents often mint and reuse them while debugging
 * services they just created, and a dead `[REDACTED:authorization]` placeholder breaks that loop.
 * The `authorization` kind remains in the schema for historical `safety.redaction.applied` facts.
 */
export function redactSensitiveText(input: string): RedactionResult<string> {
  const counts = new Map<SensitiveDataKind, number>();
  const record = (kind: SensitiveDataKind): string => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return `[REDACTED:${kind}]`;
  };

  let value = input;
  value = value.replace(/\b((?:https?|wss?):\/\/[^\s\/:@]+:)([^\s\/@]+)(@)/gi, (match, prefix: string, secret: string, suffix: string) => {
    if (alreadyRedacted.test(secret.trim())) return match;
    return `${prefix}${record("url-credential")}${suffix}`;
  });
  value = value.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
    (match) => (alreadyRedacted.test(match) ? match : record("provider-token")),
  );
  value = value.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{1,100000}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    () => record("private-key"),
  );

  return { value, redactions: summaries(counts) };
}

/** Recursively sanitizes JSON-like values while preserving their shape. */
export function redactSensitiveValue<T>(input: T): RedactionResult<T> {
  const counts = new Map<SensitiveDataKind, number>();
  const seen = new WeakMap<object, unknown>();

  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactSensitiveText(value);
      merge(counts, result.redactions);
      return result.value;
    }
    if (typeof value !== "object" || value === null) return value;
    const prior = seen.get(value);
    if (prior !== undefined) return prior;
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const item of value) copy.push(visit(item));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, child] of Object.entries(value)) copy[key] = visit(child);
    return copy;
  };

  return { value: visit(input) as T, redactions: summaries(counts) };
}

export function mergeRedactionSummaries(
  ...groups: readonly (readonly RedactionSummary[])[]
): readonly RedactionSummary[] {
  const counts = new Map<SensitiveDataKind, number>();
  for (const group of groups) merge(counts, group);
  return summaries(counts);
}

function merge(counts: Map<SensitiveDataKind, number>, entries: readonly RedactionSummary[]): void {
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + entry.count);
}

function summaries(counts: ReadonlyMap<SensitiveDataKind, number>): readonly RedactionSummary[] {
  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => Object.freeze({ kind, count })));
}
