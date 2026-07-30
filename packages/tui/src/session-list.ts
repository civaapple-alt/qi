import type { SessionSummary } from "@civaapple/qi-agent/kernel";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";

export const SESSION_PREVIEW_MAX_CHARS = 80;

export interface SessionEntry {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly workspaceRoot: string;
  readonly preview: string;
  readonly location: "active" | "archived";
  readonly lifecycle: string;
}

/** Collapse whitespace and truncate for session list previews. */
export function collapsePreviewText(text: string, maxChars = SESSION_PREVIEW_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Last meaningful text from `run.triggered` input or `model.completed` text
 * (most recent event wins).
 */
export function sessionPreviewText(
  events: readonly SessionEvent[],
  maxChars = SESSION_PREVIEW_MAX_CHARS,
): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "model.completed") {
      const text = event.data.text.trim();
      if (text) return collapsePreviewText(text, maxChars);
    }
    if (event.type === "run.triggered") {
      const input = event.data.input?.trim();
      if (input) return collapsePreviewText(input, maxChars);
    }
  }
  return "";
}

/** Relative age label: just now / 5m ago / 3h ago / 2d ago / YYYY-MM-DD. */
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso || "";
  const deltaMs = Math.max(0, nowMs - then);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 8)}…`;
}

export function buildSessionEntries(
  summaries: readonly SessionSummary[],
  options: {
    readonly workspaceRoot: string;
    readonly readEvents: (sessionId: SessionId) => readonly SessionEvent[];
  },
): SessionEntry[] {
  return summaries.map((summary) => ({
    sessionId: summary.sessionId,
    title: summary.title,
    version: summary.version,
    updatedAt: summary.updatedAt,
    workspaceRoot: options.workspaceRoot,
    preview: sessionPreviewText(options.readEvents(summary.sessionId)),
    location: "location" in summary && summary.location === "archived" ? "archived" : "active",
    lifecycle: "lifecycle" in summary && typeof summary.lifecycle === "string"
      ? summary.lifecycle
      : "active",
  }));
}
