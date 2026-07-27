export type SensitiveDataKind =
  | "credential-assignment"
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

const secretKey = String.raw`(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|refresh[_-]?token)`;
const alreadyRedacted = /^\[REDACTED:[a-z-]+\]$/i;

/**
 * Removes high-confidence credential material without retaining the matched value.
 * This is a last-resort safety boundary, not a replacement for opaque credential handles.
 */
export function redactSensitiveText(input: string): RedactionResult<string> {
  const counts = new Map<SensitiveDataKind, number>();
  const record = (kind: SensitiveDataKind): string => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return `[REDACTED:${kind}]`;
  };

  let value = input;
  value = value.replace(
    new RegExp(`((?:["']?${secretKey}["']?)\\s*[:=]\\s*)(["'])([^"'\\r\\n]{1,4096})(["'])`, "gi"),
    (match, prefix: string, open: string, candidate: string, close: string) => {
      if (open !== close || alreadyRedacted.test(candidate.trim())) return match;
      return `${prefix}${open}${record("credential-assignment")}${close}`;
    },
  );
  value = value.replace(
    new RegExp(`((?:["']?${secretKey}["']?)\\s*[:=]\\s*)([^\\s,;{}\\]"']{4,4096})`, "gi"),
    (match, prefix: string, candidate: string) => {
      if (alreadyRedacted.test(candidate) || looksLikeCodeReference(candidate)) return match;
      return `${prefix}${record("credential-assignment")}`;
    },
  );
  value = value.replace(/(authorization\s*:\s*bearer\s+)([^\s,;]{8,4096})/gi, (_match, prefix: string) => (
    `${prefix}${record("authorization")}`
  ));
  value = value.replace(/\b((?:https?|wss?):\/\/[^\s\/:@]+:)([^\s\/@]+)(@)/gi, (_match, prefix: string, _secret: string, suffix: string) => (
    `${prefix}${record("url-credential")}${suffix}`
  ));
  value = value.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
    () => record("provider-token"),
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

function looksLikeCodeReference(value: string): boolean {
  return /^(?:process\.env\.|Deno\.env|os\.environ|env\(|System\.getenv|Type\.|String\(|optional|required|undefined|null|true|false|\$\{|<)/i.test(value);
}

function merge(counts: Map<SensitiveDataKind, number>, entries: readonly RedactionSummary[]): void {
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + entry.count);
}

function summaries(counts: ReadonlyMap<SensitiveDataKind, number>): readonly RedactionSummary[] {
  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => Object.freeze({ kind, count })));
}
