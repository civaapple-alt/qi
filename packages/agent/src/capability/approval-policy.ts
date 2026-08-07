import type { Effect } from "./broker.js";
import {
  permissionAutoAcceptsInLease,
  type PermissionMode,
} from "./permission-mode.js";
import type { SessionMode } from "./mode-policy.js";
import { modeAllowsIntent } from "./mode-policy.js";

/** Scope chosen when the human approves (manual mode). */
export type ApprovalScope = "once" | "session" | "project";

export type ApprovalDecisionKind = "approve" | "deny" | "ask";

export interface ApprovalPattern {
  readonly tool: string;
  readonly effect: Effect;
  /** Normalized resource class, e.g. workspace:file:src/** or shell-profile:direct */
  readonly resourceClass: string;
}

export interface StoredApproval {
  readonly pattern: ApprovalPattern;
  readonly decision: "allow" | "deny";
  readonly scope: "session" | "project";
  readonly createdAt: string;
  readonly source?: string;
}

export interface ApprovalEvaluationInput {
  readonly permissionMode: PermissionMode;
  readonly sessionMode?: SessionMode;
  readonly tool: string;
  readonly effect: Effect;
  readonly resources: readonly string[];
  /** Precomputed pattern; if omitted, derived from tool/effect/resources. */
  readonly pattern?: ApprovalPattern;
  /** True when this Action is pure read discovery (list/search/read non-sensitive). */
  readonly isDefaultRead?: boolean;
  /** True when the path is outside Workspace and needs a mount grant (authority expansion). */
  readonly requiresMountGrant?: boolean;
  /** Session-scoped remembered decisions. */
  readonly sessionMemory?: readonly StoredApproval[];
  /** Project-scoped remembered decisions (from policy.toml). */
  readonly projectMemory?: readonly StoredApproval[];
}

export type ApprovalEvaluationResult =
  | {
      readonly kind: "approve";
      readonly reason: string;
      readonly policy: string;
      readonly pattern: ApprovalPattern;
    }
  | {
      readonly kind: "deny";
      readonly reason: string;
      readonly policy: string;
      readonly pattern: ApprovalPattern;
    }
  | {
      readonly kind: "ask";
      readonly reason: string;
      readonly policy: string;
      readonly pattern: ApprovalPattern;
      /** Allowed scopes the UI should offer (deny is always available). */
      readonly allowedScopes: readonly ApprovalScope[];
    };

const DEFAULT_READ_TOOLS = new Set([
  "read",
  "list",
  "search",
  "find",
  "tree",
  "git",
  "fetch",
  "web_map",
  "skill",
  "plugin_skill",
  "mcp_catalog",
  "artifact",
  "artifact_get",
  "qi_introspect",
  "qi_session_inspect",
  "memory",
  "ask_question",
  "update_plan",
  "plan_document",
]);

/**
 * Build a stable approval pattern. Prefer directory trees for files; shell uses profile class only.
 */
export function buildApprovalPattern(
  tool: string,
  effect: Effect,
  resources: readonly string[],
): ApprovalPattern {
  const primary = resources[0] ?? "*";
  let resourceClass = primary;
  if (tool === "shell" || tool === "script") {
    const profile = resources.find((r) => r.startsWith("shell-profile:")) ?? "shell-profile:*";
    resourceClass = profile;
  } else if (tool === "verify") {
    const verification = resources.find((r) => r.startsWith("verification:")) ?? "verification:*";
    resourceClass = verification;
  } else if (primary.startsWith("workspace:file:") || primary.startsWith("file:")) {
    resourceClass = directoryClass(primary);
  } else if (primary.startsWith("network:")) {
    resourceClass = primary;
  } else if (tool === "delegate") {
    resourceClass = "delegate:*";
  }
  return { tool, effect, resourceClass };
}

function directoryClass(resource: string): string {
  const prefix = resource.startsWith("workspace:file:")
    ? "workspace:file:"
    : resource.startsWith("file:")
      ? "file:"
      : "";
  if (!prefix) return resource;
  const path = resource.slice(prefix.length).replace(/\\/g, "/");
  if (!path || path === "*" || path === "**") return `${prefix}**`;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return `${prefix}${parts[0] ?? "**"}`;
  // Remember parent directory tree by default (not entire workspace root).
  const dir = parts.slice(0, -1).join("/");
  return `${prefix}${dir}/**`;
}

export function patternKey(pattern: ApprovalPattern): string {
  return `tool:${pattern.tool};effect:${pattern.effect};resource:${pattern.resourceClass}`;
}

export function patternMatches(stored: ApprovalPattern, candidate: ApprovalPattern): boolean {
  if (stored.tool !== candidate.tool || stored.effect !== candidate.effect) return false;
  if (stored.resourceClass === candidate.resourceClass) return true;
  if (stored.resourceClass.endsWith("/**")) {
    const prefix = stored.resourceClass.slice(0, -3);
    return (
      candidate.resourceClass === prefix ||
      candidate.resourceClass.startsWith(`${prefix}/`) ||
      candidate.resourceClass.startsWith(prefix)
    );
  }
  if (stored.resourceClass.endsWith(":*") || stored.resourceClass.endsWith(":**")) {
    const prefix = stored.resourceClass.replace(/\*\*?$/, "");
    return candidate.resourceClass.startsWith(prefix);
  }
  return false;
}

function findMemory(
  memory: readonly StoredApproval[] | undefined,
  pattern: ApprovalPattern,
): StoredApproval | undefined {
  if (!memory?.length) return undefined;
  for (let index = memory.length - 1; index >= 0; index -= 1) {
    const entry = memory[index];
    if (entry && patternMatches(entry.pattern, pattern)) return entry;
  }
  return undefined;
}

/**
 * Ordered approval policy (ADR-0040). Call after intent is known; does not replace CapabilityBroker.
 */
export function evaluateApprovalPolicy(input: ApprovalEvaluationInput): ApprovalEvaluationResult {
  const pattern =
    input.pattern ?? buildApprovalPattern(input.tool, input.effect, input.resources);

  const modeGate = modeAllowsIntent(input.sessionMode, input.tool, input.effect);
  if (!modeGate.ok) {
    return {
      kind: "deny",
      reason: modeGate.reason,
      policy: "session-mode-deny",
      pattern,
    };
  }

  if (input.requiresMountGrant) {
    return {
      kind: "ask",
      reason: "Path is outside the Workspace; mount grant required",
      policy: "mount-grant-required",
      pattern,
      allowedScopes: ["once", "session", "project"],
    };
  }

  const sessionHit = findMemory(input.sessionMemory, pattern);
  if (sessionHit) {
    return sessionHit.decision === "allow"
      ? {
          kind: "approve",
          reason: "Matched session approval memory",
          policy: "approval-memory-session",
          pattern,
        }
      : {
          kind: "deny",
          reason: "Matched session denial memory",
          policy: "approval-memory-session",
          pattern,
        };
  }

  const projectHit = findMemory(input.projectMemory, pattern);
  if (projectHit) {
    return projectHit.decision === "allow"
      ? {
          kind: "approve",
          reason: "Matched project approval memory",
          policy: "approval-memory-project",
          pattern,
        }
      : {
          kind: "deny",
          reason: "Matched project denial memory",
          policy: "approval-memory-project",
          pattern,
        };
  }

  const defaultRead =
    input.isDefaultRead === true ||
    (input.effect === "read" && DEFAULT_READ_TOOLS.has(input.tool));
  if (defaultRead && input.effect === "read") {
    return {
      kind: "approve",
      reason: "Default read discovery",
      policy: "default-read-approve",
      pattern,
    };
  }

  if (permissionAutoAcceptsInLease(input.permissionMode)) {
    return {
      kind: "approve",
      reason: `${input.permissionMode} auto-accepts in-lease actions`,
      policy: "yolo-or-auto-accept",
      pattern,
    };
  }

  // manual: ask for non-read (and non-default-read) actions
  return {
    kind: "ask",
    reason: "Manual permission mode requires approval",
    policy: "fallback-ask",
    pattern,
    allowedScopes: ["once", "session", "project"],
  };
}

export function rememberApproval(options: {
  readonly pattern: ApprovalPattern;
  readonly decision: "allow" | "deny";
  readonly scope: Exclude<ApprovalScope, "once">;
  readonly createdAt?: string;
  readonly source?: string;
}): StoredApproval {
  return {
    pattern: options.pattern,
    decision: options.decision,
    scope: options.scope,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.source === undefined ? {} : { source: options.source }),
  };
}

/** Serialize for policy.toml [[approvals]] pattern field. */
export function serializeApprovalPattern(pattern: ApprovalPattern): string {
  return patternKey(pattern);
}

export function parseApprovalPattern(serialized: string): ApprovalPattern | undefined {
  const toolMatch = /tool:([^;]+)/.exec(serialized);
  const effectMatch = /effect:([^;]+)/.exec(serialized);
  const resourceMatch = /resource:(.+)$/.exec(serialized);
  if (!toolMatch?.[1] || !effectMatch?.[1] || !resourceMatch?.[1]) return undefined;
  const effect = effectMatch[1] as Effect;
  if (!["read", "write", "execute", "publish", "spend"].includes(effect)) return undefined;
  return {
    tool: toolMatch[1],
    effect,
    resourceClass: resourceMatch[1],
  };
}
