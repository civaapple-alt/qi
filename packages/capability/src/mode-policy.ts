export type SessionMode = "ask" | "plan" | "agent";
type Effect = "read" | "write" | "execute" | "publish" | "spend";

const askTools = new Set([
  "read",
  "list",
  "search",
  "find",
  "tree",
  "git",
  "fetch",
  "skill",
  "artifact",
  "qi_introspect",
  "qi_session_inspect",
]);
const planExtraTools = new Set(["plan_document", "delegate"]);

/** Tools Ask mode may advertise (registry intersection still applies). */
export const ASK_MODE_TOOLS: readonly string[] = [...askTools];

/** Tools Plan mode may advertise beyond Ask. */
export const PLAN_MODE_EXTRA_TOOLS: readonly string[] = [...planExtraTools];

export function toolsForMode(mode: SessionMode, registered: readonly string[]): string[] {
  const available = new Set(registered);
  if (mode === "ask") return ASK_MODE_TOOLS.filter((name) => available.has(name));
  if (mode === "plan") {
    return [...ASK_MODE_TOOLS, ...PLAN_MODE_EXTRA_TOOLS].filter((name) => available.has(name));
  }
  return registered.filter((name) => name !== "plan_document" && available.has(name));
}

export function isToolAllowedInMode(mode: SessionMode, toolName: string): boolean {
  if (toolName === "plan_document") return mode === "plan";
  if (mode === "agent") return true;
  if (askTools.has(toolName)) return true;
  return mode === "plan" && planExtraTools.has(toolName);
}

/** Mode may only narrow launch leases; never invent authority. */
export function modeAllowsIntent(
  mode: SessionMode | undefined,
  tool: string,
  effect: Effect,
): { ok: true } | { ok: false; reason: string } {
  if (mode === undefined || mode === "agent") {
    if (tool === "plan_document") {
      return { ok: false, reason: "plan_document is only available in Plan mode" };
    }
    return { ok: true };
  }
  if (!isToolAllowedInMode(mode, tool)) {
    return { ok: false, reason: `${mode} mode denies tool ${tool}` };
  }
  if (mode === "ask" && effect !== "read") {
    return { ok: false, reason: `Ask mode denies ${effect} effects` };
  }
  if (mode === "plan") {
    if (tool === "plan_document" && effect !== "write") {
      return { ok: false, reason: "plan_document must declare write effect" };
    }
    if (tool === "delegate" && effect !== "read") {
      return { ok: false, reason: "delegate must declare read effect" };
    }
    if (tool !== "plan_document" && effect !== "read") {
      return { ok: false, reason: `Plan mode denies ${effect} effects for ${tool}` };
    }
  }
  return { ok: true };
}

export const SESSION_MODES: readonly SessionMode[] = ["ask", "plan", "agent"];

export function nextSessionMode(current: SessionMode): SessionMode {
  const index = SESSION_MODES.indexOf(current);
  return SESSION_MODES[(index + 1) % SESSION_MODES.length] ?? "agent";
}

export function formatModeLabel(mode: SessionMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    case "agent":
      return "Agent";
  }
}
