/**
 * ACP session/update flood control.
 *
 * Goals for IDE clients (esp. VS Code ACP Client):
 * - See thinking progress without waiting minutes for model.completed
 * - Not typewriter/token spam
 * - Not one 30–50KB notify that freezes the UI
 *
 * Defaults:
 * - assistant text: one chunk per Step at model.completed
 * - thoughts: off
 *
 * QI_ACP_STREAM_THOUGHTS=1 → progressive thought refresh (~5s, size-capped).
 * QI_ACP_STREAM_THOUGHTS=end → only at model.completed (bounded).
 * QI_ACP_STREAM_THOUGHTS=live → faster progressive (default 1.5s).
 */

export type ThoughtDelivery = "off" | "progressive" | "end";

export interface AcpStreamPolicy {
  /** Live provisional assistant text (default false). */
  readonly streamText: boolean;
  readonly thoughts: ThoughtDelivery;
  /**
   * Minimum interval between progressive thought (or live text) flushes.
   * Default 5000ms for progressive thoughts.
   */
  readonly coalesceMs: number;
  /**
   * Max characters per agent_thought_chunk / live text flush.
   * Default 3500 — large enough to read, small enough for VS Code.
   */
  readonly maxChunkChars: number;
}

/** Default progressive thought refresh interval. */
export const ACP_THOUGHT_REFRESH_MS = 5_000;
/** Hard cap per thought notify. */
export const ACP_THOUGHT_MAX_CHARS = 3_500;

export function resolveAcpStreamPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AcpStreamPolicy {
  const streamText = envFlag(environment.QI_ACP_STREAM_TEXT);
  const thoughts = resolveThoughtDelivery(environment);
  const defaultMs = thoughts === "progressive"
    ? (environment.QI_ACP_STREAM_THOUGHTS?.trim().toLowerCase() === "live" ? 1_500 : ACP_THOUGHT_REFRESH_MS)
    : 1_500;
  const coalesceMs = parsePositiveInt(environment.QI_ACP_COALESCE_MS, defaultMs);
  const maxChunkChars = parsePositiveInt(
    environment.QI_ACP_COALESCE_CHARS ?? environment.QI_ACP_THOUGHT_MAX_CHARS,
    ACP_THOUGHT_MAX_CHARS,
  );
  return {
    streamText,
    thoughts,
    coalesceMs: Math.max(250, coalesceMs),
    maxChunkChars: Math.min(8_000, Math.max(500, maxChunkChars)),
  };
}

function resolveThoughtDelivery(
  environment: Readonly<Record<string, string | undefined>>,
): ThoughtDelivery {
  if (envFlag(environment.QI_ACP_STREAM_THOUGHTS_LIVE)) return "progressive";
  const raw = environment.QI_ACP_STREAM_THOUGHTS?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return "off";
  }
  if (raw === "end" || raw === "step" || raw === "complete" || raw === "final") return "end";
  // "1" / "true" / "yes" / "on" / "live" / "progressive" → progressive refresh
  return "progressive";
}

function envFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Slice cumulative activity text into a true wire delta. */
export function cumulativeToDelta(previous: string, full: string): { delta: string; next: string } {
  if (!full) return { delta: "", next: previous };
  if (full.startsWith(previous)) {
    return { delta: full.slice(previous.length), next: full };
  }
  return { delta: full, next: full };
}

/**
 * Bound a single thought payload for IDE. Full CoT remains in Session/Web.
 */
export function boundThoughtForAcp(text: string, maxChars = ACP_THOUGHT_MAX_CHARS): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  const head = trimmed.slice(0, Math.max(1, maxChars - 90));
  return `${head}\n\n… [thinking truncated for IDE · ${trimmed.length} chars total · full CoT in Session / Web]`;
}

/**
 * Choose what to emit from unsent cumulative thought for a progressive refresh.
 * Prefers the **latest** window so a slow CoT shows current progress, not only the start.
 */
export function takeProgressiveThoughtSlice(
  unsent: string,
  maxChars: number,
): { emit: string; consumed: number } {
  if (!unsent) return { emit: "", consumed: 0 };
  if (unsent.length <= maxChars) {
    return { emit: unsent, consumed: unsent.length };
  }
  // Skip middle of this interval; show newest portion.
  const tail = unsent.slice(-maxChars);
  return {
    emit: `…\n${tail}`,
    consumed: unsent.length,
  };
}

/** @deprecated use takeProgressiveThoughtSlice — kept for tests that split static blobs */
export function splitThoughtChunks(text: string, maxChars = ACP_THOUGHT_MAX_CHARS): string[] {
  const bounded = boundThoughtForAcp(text, maxChars * 3);
  if (!bounded) return [];
  if (bounded.length <= maxChars) return [bounded];
  const parts: string[] = [];
  for (let i = 0; i < bounded.length; i += maxChars) {
    parts.push(bounded.slice(i, i + maxChars));
  }
  return parts;
}
