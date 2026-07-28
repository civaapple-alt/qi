import { randomUUID } from "node:crypto";
import type { CapabilityLease, DelegatedLeaseRequest, InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import type { EventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { createId, type RunId, type SessionId } from "@civaapple/qi-protocol";
import type { ArtifactStore } from "@civaapple/qi-agent/tools";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface DelegationEvidenceRequirement {
  kind: "deterministic" | "behavioral" | "semantic" | "human";
  minimum: number;
}

export interface DelegationContract {
  outcome: string;
  deliverableSchema: TSchema;
  contextRefs: readonly string[];
  workspaceBranch?: string;
  parentLeaseId: string;
  childLease: Omit<DelegatedLeaseRequest, "leaseId" | "subject">;
  resourceEnvelope: Readonly<{
    contextTokens: number;
    maxSteps: number;
    wallTimeMs: number;
    maxActionsPerStep?: number;
    [key: string]: number | undefined;
  }>;
  evidenceRequired: readonly DelegationEvidenceRequirement[];
  returnPolicy: "result" | "result+trace" | "evidence-only";
}

export interface DelegationHandle {
  delegationId: string;
  childSessionId: SessionId;
  childSubject: string;
  capabilityLease: CapabilityLease;
  contractRef: string;
  workspaceBranch?: string;
  startedAt: number;
}

export interface DelegationSubmission {
  result?: unknown;
  resultRef?: string;
  summaryRef?: string;
  traceRef?: string;
  evidence: readonly { kind: DelegationEvidenceRequirement["kind"]; ref: string }[];
  outcome?: "accepted" | "rejected" | "cancelled" | "timed_out" | "failed";
  reasons?: readonly string[];
}

export interface WorkspaceBranchPort {
  createBranch(delegationId: string): Promise<{ ref: string }>;
}

export interface DelegationAuthorization {
  receiptId: string;
  parentSubject: string;
}

interface ActiveDelegation {
  handle: DelegationHandle;
  contract: DelegationContract;
}

export class Coordinator {
  readonly #store: EventStore;
  readonly #broker: InMemoryCapabilityBroker;
  readonly #parentSessionId: SessionId;
  readonly #runId: RunId;
  readonly #artifacts: ArtifactStore;
  readonly #writer: EventWriter;
  readonly #clock: () => Date;
  readonly #brancher: WorkspaceBranchPort | undefined;
  readonly #active = new Map<string, ActiveDelegation>();

  constructor(options: {
    store: EventStore;
    broker: InMemoryCapabilityBroker;
    parentSessionId: SessionId;
    runId: RunId;
    artifactStore: ArtifactStore;
    brancher?: WorkspaceBranchPort;
    clock?: () => Date;
  }) {
    this.#store = options.store;
    this.#broker = options.broker;
    this.#parentSessionId = options.parentSessionId;
    this.#runId = options.runId;
    this.#artifacts = options.artifactStore;
    this.#clock = options.clock ?? (() => new Date());
    this.#brancher = options.brancher;
    this.#writer = new EventWriter(options.store, options.parentSessionId, this.#clock);
  }

  async delegate(contract: DelegationContract, authorization: DelegationAuthorization): Promise<DelegationHandle> {
    validateContract(contract);
    if (authorization.parentSubject.startsWith("subagent:")) {
      throw new Error("Depth>1 delegation is not allowed; child subjects cannot delegate");
    }
    this.#assertDelegationReceipt(authorization.receiptId, authorization.parentSubject);

    const delegationId = `dlg_${randomUUID()}`;
    const childSessionId = createId("ses") as SessionId;
    const childSubject = `subagent:${delegationId}`;
    if (contract.childLease.tools.some((tool) => tool === "delegate" || tool === "coordinator.delegate" || tool.includes("delegate"))) {
      throw new TypeError("Child leases cannot include delegation tools");
    }
    const branch = contract.workspaceBranch
      ?? (this.#brancher ? (await this.#brancher.createBranch(delegationId)).ref : undefined);
    const capabilityLease = this.#broker.delegate(contract.parentLeaseId, {
      leaseId: `lea_${randomUUID()}`,
      subject: childSubject,
      ...contract.childLease,
    });
    const contractRef = await this.#persistContract(contract);
    const handle: DelegationHandle = {
      delegationId,
      childSessionId,
      childSubject,
      capabilityLease,
      contractRef,
      ...(branch === undefined ? {} : { workspaceBranch: branch }),
      startedAt: this.#clock().getTime(),
    };
    this.#writer.append("delegation.created", {
      runId: this.#runId,
      delegationId,
      childSessionId,
      outcome: contract.outcome,
      returnPolicy: contract.returnPolicy,
      depth: 1,
      receiptId: authorization.receiptId,
      parentLeaseId: contract.parentLeaseId,
      childLeaseId: capabilityLease.leaseId,
      childSubject,
      contextRefs: [...contract.contextRefs],
      contractRef,
      resourceEnvelope: Object.fromEntries(
        Object.entries(contract.resourceEnvelope).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      ),
      ...(branch === undefined ? {} : { workspaceBranch: branch }),
    }, { kind: "runtime", id: "coordinator" });
    const childWriter = new EventWriter(this.#store, childSessionId, this.#clock);
    childWriter.append(
      "session.created",
      { title: `Delegated: ${contract.outcome.slice(0, 160)}` },
      { kind: "runtime", id: "coordinator" },
    );
    this.#active.set(delegationId, { handle, contract });
    return structuredClone(handle);
  }

  return(handle: DelegationHandle, submission: DelegationSubmission): { accepted: boolean; reasons: string[] } {
    const active = this.#active.get(handle.delegationId) ?? this.#hydrateActive(handle.delegationId);
    if (!active || active.handle.childSessionId !== handle.childSessionId) {
      throw new Error("Delegation is unknown or already settled");
    }
    const forced = submission.outcome;
    const reasons: string[] = [...(submission.reasons ?? [])];
    const { contract } = active;
    const skipSchema = forced === "cancelled" || forced === "timed_out" || forced === "failed";
    if (!skipSchema) {
      if (contract.returnPolicy !== "evidence-only" && !Value.Check(contract.deliverableSchema, submission.result)) {
        reasons.push(`Deliverable schema mismatch: ${formatErrors(contract.deliverableSchema, submission.result)}`);
      }
      if (contract.returnPolicy !== "evidence-only" && !submission.resultRef) reasons.push("A durable resultRef is required");
      if (contract.returnPolicy === "result+trace" && !submission.traceRef) reasons.push("A traceRef is required");
      for (const requirement of contract.evidenceRequired) {
        const count = submission.evidence.filter((item) => item.kind === requirement.kind).length;
        if (count < requirement.minimum) {
          reasons.push(`Expected ${requirement.minimum} ${requirement.kind} evidence item(s), received ${count}`);
        }
      }
    }
    const valid = reasons.length === 0;
    let outcome: NonNullable<DelegationSubmission["outcome"]>;
    if (forced === "cancelled" || forced === "timed_out" || forced === "failed") {
      outcome = forced;
    } else if (forced === "rejected") {
      outcome = "rejected";
    } else if (forced === "accepted") {
      outcome = valid ? "accepted" : "rejected";
    } else {
      outcome = valid ? "accepted" : "rejected";
    }
    const refs = [...new Set(submission.evidence.map((item) => item.ref))];
    if (submission.traceRef) refs.push(submission.traceRef);
    this.#writer.append("delegation.returned", {
      runId: this.#runId,
      delegationId: handle.delegationId,
      childSessionId: handle.childSessionId,
      outcome,
      ...(submission.resultRef === undefined ? {} : { resultRef: submission.resultRef }),
      ...(submission.summaryRef === undefined ? {} : { summaryRef: submission.summaryRef }),
      evidenceRefs: [...new Set(refs)],
      coordinationWallTimeMs: Math.max(0, this.#clock().getTime() - active.handle.startedAt),
      ...(reasons.length === 0 ? {} : { reasons }),
    }, { kind: "runtime", id: "coordinator" });
    this.#active.delete(handle.delegationId);
    return {
      accepted: outcome === "accepted",
      reasons,
    };
  }

  /** Cancel every running delegation on the parent Run without re-entering child executors. */
  cancelRunning(reason = "Process restarted while delegation was unsettled"): number {
    const view = this.#store.load(this.#parentSessionId);
    const run = view?.runs[this.#runId];
    if (!run) return 0;
    let cancelled = 0;
    for (const delegation of Object.values(run.delegations)) {
      if (delegation.status !== "running") continue;
      this.#writer.append("delegation.returned", {
        runId: this.#runId,
        delegationId: delegation.delegationId,
        childSessionId: delegation.childSessionId,
        outcome: "cancelled",
        evidenceRefs: [],
        coordinationWallTimeMs: 0,
        reasons: [reason],
      }, { kind: "runtime", id: "coordinator" });
      this.#active.delete(delegation.delegationId);
      cancelled += 1;
    }
    return cancelled;
  }

  #assertDelegationReceipt(receiptId: string, parentSubject: string): void {
    const view = this.#store.load(this.#parentSessionId);
    const receipt = view?.controlReceipts[receiptId];
    if (!receipt) throw new Error(`Control receipt ${receiptId} was not found`);
    if (receipt.phase !== "granted") throw new Error(`Control receipt ${receiptId} is not an active grant`);
    if (!receipt.delegationRight) throw new Error("Control receipt does not grant delegation right");
    if (receipt.issuedTo !== parentSubject && receipt.issuedTo !== "user") {
      throw new Error("Control receipt is not issued to the parent subject");
    }
  }

  async #persistContract(contract: DelegationContract): Promise<string> {
    const payload = Buffer.from(JSON.stringify({
      outcome: contract.outcome,
      contextRefs: contract.contextRefs,
      parentLeaseId: contract.parentLeaseId,
      childLease: contract.childLease,
      resourceEnvelope: contract.resourceEnvelope,
      evidenceRequired: contract.evidenceRequired,
      returnPolicy: contract.returnPolicy,
      deliverableSchema: contract.deliverableSchema,
      ...(contract.workspaceBranch === undefined ? {} : { workspaceBranch: contract.workspaceBranch }),
    }), "utf8");
    const stored = await this.#artifacts.put(payload, "application/json");
    return stored.ref;
  }

  #hydrateActive(delegationId: string): ActiveDelegation | undefined {
    const view = this.#store.load(this.#parentSessionId);
    const recorded = view?.runs[this.#runId]?.delegations[delegationId];
    if (!recorded || recorded.status !== "running") return undefined;
    // Contract body remains in contractRef; return() for crash paths uses forced outcomes and does not need schema re-check.
    const handle: DelegationHandle = {
      delegationId: recorded.delegationId,
      childSessionId: recorded.childSessionId,
      childSubject: recorded.childSubject,
      capabilityLease: {
        leaseId: recorded.childLeaseId,
        subject: recorded.childSubject,
        tools: [],
        effects: [],
        resources: [],
        expiresAt: "1970-01-01T00:00:00.000Z",
      },
      contractRef: recorded.contractRef,
      ...(recorded.workspaceBranch === undefined ? {} : { workspaceBranch: recorded.workspaceBranch }),
      startedAt: this.#clock().getTime(),
    };
    const contract: DelegationContract = {
      outcome: recorded.outcome,
      deliverableSchema: { type: "object" } as unknown as TSchema,
      contextRefs: recorded.contextRefs,
      parentLeaseId: recorded.parentLeaseId,
      childLease: {
        tools: ["read"],
        effects: ["read"],
        resources: ["file:**"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      resourceEnvelope: {
        contextTokens: recorded.resourceEnvelope.contextTokens ?? 1,
        maxSteps: recorded.resourceEnvelope.maxSteps ?? 1,
        wallTimeMs: recorded.resourceEnvelope.wallTimeMs ?? 1,
        ...recorded.resourceEnvelope,
      },
      evidenceRequired: [],
      returnPolicy: recorded.returnPolicy,
    };
    const active = { handle, contract };
    this.#active.set(delegationId, active);
    return active;
  }
}

function validateContract(contract: DelegationContract): void {
  if (!contract.outcome.trim()) throw new TypeError("Delegation outcome is required");
  if (!contract.parentLeaseId || contract.childLease.tools.length === 0 || contract.childLease.effects.length === 0 || contract.childLease.resources.length === 0) {
    throw new TypeError("Delegation requires an explicit parent and non-empty child capability scope");
  }
  for (const key of ["contextTokens", "maxSteps", "wallTimeMs"] as const) {
    const limit = contract.resourceEnvelope[key];
    if (!Number.isFinite(limit) || (limit as number) <= 0) {
      throw new TypeError(`Delegation resourceEnvelope.${key} must be a positive number`);
    }
  }
  for (const [resource, limit] of Object.entries(contract.resourceEnvelope)) {
    if (!resource || limit === undefined || !Number.isFinite(limit) || limit <= 0) {
      throw new TypeError("Delegation resource limits must be positive");
    }
  }
  for (const requirement of contract.evidenceRequired) {
    if (!Number.isInteger(requirement.minimum) || requirement.minimum < 1) {
      throw new TypeError("Evidence minimum must be a positive integer");
    }
  }
  for (const ref of contract.contextRefs) {
    if (!/^artifact:\/\/[a-f0-9]{64}$/.test(ref)) {
      throw new TypeError(`contextRefs must be content-addressed artifact:// references: ${ref}`);
    }
  }
}

function formatErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)].slice(0, 4).map((error) => `${error.path || "/"}: ${error.message}`).join("; ");
}
