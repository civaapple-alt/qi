/**
 * Cursor-style research brief for depth-1 Subagents: objective + Focus + Return + Constraints.
 * The short objective remains the durable `delegation.outcome` title; the brief is the child Turn input.
 */

export interface DelegatedTaskBudget {
  maxSteps: number;
  wallTimeMs: number;
  contextTokens: number;
}

export interface DelegatedTaskBriefParts {
  objective: string;
  focus?: readonly string[];
  returns?: readonly string[];
  constraints?: readonly string[];
  /** Actual child envelope for this Turn; injected into Constraints when present. */
  budget?: DelegatedTaskBudget;
}

const DEFAULT_FOCUS = [
  "Authoritative sources and entry points in the allowlisted context/URLs",
  "Concrete integration steps for the stated SDK or stack",
  "Auth, endpoints, models, and request/response shapes",
  "Pitfalls, limits, and differences from naive OpenAI assumptions",
] as const;

const DEFAULT_RETURNS = [
  "Key official URLs or file paths with one-line notes",
  "Concrete code-relevant facts (baseURL, model ids, field names) the parent can synthesize",
  "Gaps or uncertainties that the parent must still verify",
  "Short recommendations grounded in the sources (not an exhaustive site dump)",
] as const;

const DEFAULT_CONSTRAINTS = [
  "Read-only research; do not claim parent Session authority or edit files",
  "Prefer official documentation; cite URLs or paths in the summary",
  "Return structured, synthesizable facts — not a full mirror of every page",
  "If the budget is tight, prioritize Return items over exhaustive crawling",
] as const;

/** Build the child user-message brief (Cursor explore-task shape). */
export function buildDelegatedTaskBrief(parts: DelegatedTaskBriefParts): string {
  const objective = parts.objective.trim();
  if (!objective) throw new TypeError("Delegated task objective must not be empty");
  const focus = normalizeList(parts.focus, DEFAULT_FOCUS);
  const returns = normalizeList(parts.returns, DEFAULT_RETURNS);
  // Always keep safety defaults; append budget + any parent-supplied constraints.
  const constraints = uniqueLines([
    ...DEFAULT_CONSTRAINTS,
    ...(parts.budget === undefined ? [] : [formatBudgetConstraint(parts.budget)]),
    ...(parts.constraints ?? []),
  ]);
  const lines = [
    objective,
    "",
    "Focus on:",
    ...focus.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Return:",
    ...returns.map((item) => `- ${item}`),
    "",
    "Constraints:",
    ...constraints.map((item) => `- ${item}`),
  ];
  return lines.join("\n");
}

/** Short title for Tasks list / delegation.outcome (keeps event payload bounded). */
export function delegatedTaskTitle(objective: string, maxChars = 160): string {
  const text = objective.trim().replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function formatBudgetConstraint(budget: DelegatedTaskBudget): string {
  const wallMinutes = Math.max(1, Math.round(budget.wallTimeMs / 60_000));
  return (
    `Budget envelope: maxSteps=${budget.maxSteps}, wall≈${wallMinutes}m ` +
    `(${budget.wallTimeMs}ms), contextTokens=${budget.contextTokens} — ` +
    "scope Focus/Return to fit; one document surface or theme per child"
  );
}

function normalizeList(
  values: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const cleaned = uniqueLines(values ?? []);
  return cleaned.length > 0 ? cleaned : [...fallback];
}

function uniqueLines(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
