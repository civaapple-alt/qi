import { modeAllowsIntent, type SessionMode } from "./mode-policy.js";

export type Effect = "read" | "write" | "execute" | "publish" | "spend";

export interface ActionIntent {
  actionId: string;
  subject: string;
  tool: string;
  effect: Effect;
  resources: readonly string[];
  /** Frozen Run mode; when set, mode policy may only narrow lease matches. */
  mode?: SessionMode;
  sessionId?: string;
  runId?: string;
}

export interface CapabilityLease {
  leaseId: string;
  subject: string;
  tools: readonly string[];
  effects: readonly Effect[];
  resources: readonly string[];
  expiresAt: string;
  maxUses?: number;
  delegatedFrom?: string;
}

export type CapabilityDecision =
  | { outcome: "granted"; leaseId: string; reason: string; trace: CapabilityTraceEntry[] }
  | { outcome: "denied"; reason: string; trace: CapabilityTraceEntry[] };

export interface CapabilityTraceEntry {
  leaseId: string;
  matched: boolean;
  reason: string;
}

export interface DelegatedLeaseRequest {
  leaseId: string;
  subject: string;
  tools: readonly string[];
  effects: readonly Effect[];
  resources: readonly string[];
  expiresAt: string;
  maxUses?: number;
}

export interface CapabilityBroker {
  authorize(intent: ActionIntent, now?: Date): Promise<CapabilityDecision>;
}

interface LeaseState {
  lease: CapabilityLease;
  uses: number;
}

export class InMemoryCapabilityBroker implements CapabilityBroker {
  readonly #leases = new Map<string, LeaseState>();

  grant(lease: CapabilityLease): void {
    validateLease(lease);
    if (this.#leases.has(lease.leaseId)) throw new Error(`Lease ${lease.leaseId} already exists`);
    this.#leases.set(lease.leaseId, { lease: structuredClone(lease), uses: 0 });
  }

  revoke(leaseId: string): boolean {
    return this.#leases.delete(leaseId);
  }

  delegate(parentLeaseId: string, request: DelegatedLeaseRequest): CapabilityLease {
    const parentState = this.#leases.get(parentLeaseId);
    if (!parentState) throw new Error(`Parent lease ${parentLeaseId} does not exist`);
    const parent = parentState.lease;
    if (Date.parse(request.expiresAt) > Date.parse(parent.expiresAt)) {
      throw new Error("A delegated lease cannot outlive its parent");
    }
    if (!request.tools.every((candidate) => parent.tools.some((pattern) => patternContains(pattern, candidate)))) {
      throw new Error("Delegated tools exceed the parent lease");
    }
    if (!request.effects.every((effect) => parent.effects.includes(effect))) {
      throw new Error("Delegated effects exceed the parent lease");
    }
    if (!request.resources.every((candidate) => parent.resources.some((pattern) => patternContains(pattern, candidate)))) {
      throw new Error("Delegated resources exceed the parent lease");
    }
    const remainingUses = parent.maxUses === undefined ? undefined : parent.maxUses - parentState.uses;
    if (remainingUses !== undefined && (request.maxUses === undefined || request.maxUses > remainingUses)) {
      throw new Error(`Delegated maxUses exceeds the parent's ${remainingUses} remaining uses`);
    }
    const lease: CapabilityLease = {
      leaseId: request.leaseId,
      subject: request.subject,
      tools: [...request.tools],
      effects: [...request.effects],
      resources: [...request.resources],
      expiresAt: request.expiresAt,
      ...(request.maxUses === undefined ? {} : { maxUses: request.maxUses }),
      delegatedFrom: parentLeaseId,
    };
    this.grant(lease);
    return structuredClone(lease);
  }

  async authorize(intent: ActionIntent, now = new Date()): Promise<CapabilityDecision> {
    const modeGate = modeAllowsIntent(intent.mode, intent.tool, intent.effect);
    if (!modeGate.ok) {
      return {
        outcome: "denied",
        reason: modeGate.reason,
        trace: [{ leaseId: "mode_policy", matched: false, reason: modeGate.reason }],
      };
    }
    const trace: CapabilityTraceEntry[] = [];
    for (const state of this.#leases.values()) {
      const { lease } = state;
      let mismatch: string | undefined;
      if (lease.subject !== intent.subject) mismatch = "subject mismatch";
      else if (Date.parse(lease.expiresAt) <= now.getTime()) mismatch = "expired";
      else if (lease.maxUses !== undefined && state.uses >= lease.maxUses) mismatch = "use limit exhausted";
      else if (!lease.effects.includes(intent.effect)) mismatch = `effect ${intent.effect} not granted`;
      else if (!lease.tools.some((pattern) => globMatches(pattern, intent.tool))) mismatch = `tool ${intent.tool} not granted`;
      if (mismatch) {
        trace.push({ leaseId: lease.leaseId, matched: false, reason: mismatch });
        continue;
      }
      if (!intent.resources.every((resource) => lease.resources.some((pattern) => globMatches(pattern, resource)))) {
        trace.push({ leaseId: lease.leaseId, matched: false, reason: "resource scope mismatch" });
        continue;
      }

      state.uses += 1;
      trace.push({ leaseId: lease.leaseId, matched: true, reason: "all constraints matched" });
      return {
        outcome: "granted",
        leaseId: lease.leaseId,
        reason: `Matched lease ${lease.leaseId}`,
        trace,
      };
    }

    return {
      outcome: "denied",
      reason: `No active lease permits ${intent.effect} via ${intent.tool} on ${intent.resources.join(", ") || "<none>"}`,
      trace,
    };
  }
}

function validateLease(lease: CapabilityLease): void {
  if (!lease.leaseId || !lease.subject) throw new TypeError("A lease requires leaseId and subject");
  if (!/^lea_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(lease.leaseId)) {
    throw new TypeError("A lease ID must use the lea_ protocol prefix");
  }
  if (lease.tools.length === 0 || lease.effects.length === 0 || lease.resources.length === 0) {
    throw new TypeError("A lease requires at least one tool, effect and resource pattern");
  }
  if (!Number.isFinite(Date.parse(lease.expiresAt))) throw new TypeError("Lease expiresAt must be an ISO timestamp");
  if (lease.maxUses !== undefined && (!Number.isInteger(lease.maxUses) || lease.maxUses <= 0)) {
    throw new TypeError("Lease maxUses must be a positive integer");
  }
}

function globMatches(pattern: string, value: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += ".";
    } else {
      source += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  source += "$";
  return new RegExp(source).test(value);
}

function patternContains(parent: string, child: string): boolean {
  if (parent === child || parent === "**" || parent === "*") return true;
  if (!child.includes("*") && !child.includes("?")) return globMatches(parent, child);
  const broadPrefix = parent.endsWith("**") ? parent.slice(0, -2) : undefined;
  return broadPrefix !== undefined && child.startsWith(broadPrefix);
}
