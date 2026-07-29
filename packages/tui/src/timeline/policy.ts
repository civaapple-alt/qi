import type { TimelineDensity } from "./types.js";

export const DEFAULT_TIMELINE_DENSITY: TimelineDensity = "standard";
export const TIMELINE_RENDERED_LINE_LIMIT = 1_200;

export function recentRunLimit(density: TimelineDensity): number {
  if (density === "compact") return 20;
  if (density === "diagnostic") return 6;
  return 12;
}

export function normalizeTimelineDensity(value: unknown): TimelineDensity {
  return value === "compact" || value === "diagnostic" || value === "standard"
    ? value
    : DEFAULT_TIMELINE_DENSITY;
}

