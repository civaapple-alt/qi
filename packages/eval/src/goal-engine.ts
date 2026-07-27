import type { EventStore, GoalState, GoalView, ResourceName, SessionView } from "@civaapple/qi-kernel";
import {
  createId,
  parseSessionEvent,
  type EvaluationId,
  type GoalId,
  type RunId,
  type SessionEvent,
  type SessionId,
  type StepId,
} from "@civaapple/qi-protocol";
import { evaluatorIdentity, type EvaluatorCalibrationRegistry } from "./calibration.js";
import type { EvalDraft, Evaluator, SemanticEvaluator } from "./evaluator.js";
import { failureFingerprint, type FailureFingerprintInput } from "./fingerprint.js";

export interface GoalContractInput {
  objective: string;
  assertions: readonly { assertionId: string; description: string; required?: boolean }[];
  evidenceRequirements?: readonly {
    assertionId: string;
    kinds: readonly ("deterministic" | "behavioral" | "semantic" | "human")[];
    minimum?: number;
  }[];
  boundaries?: readonly string[];
  resources?: readonly { resource: ResourceName; limit: number; unit: string }[];
  stagnation?: {
    windowSteps: number;
    maxEquivalentFailures: number;
    onTrip: "change-strategy" | "narrow-scope" | "park";
  };
}

export interface ControlGrant {
  issuedTo: string;
  startRight: "user" | "schedule" | "event" | "agent";
  stopRight: "user" | "contract" | "agent";
  acceptanceRight: "human" | "evaluator" | "agent";
  delegationRight: boolean;
  actionLeaseIds: readonly string[];
}

export interface EvidenceInput {
  goalId: GoalId;
  runId?: RunId;
  assertionId?: string;
  kind: "deterministic" | "behavioral" | "semantic" | "human";
  artifactRef: string;
  description: string;
  producer: string;
  reproducible: boolean;
}

export class GoalEngine {
  readonly #store: EventStore;
  readonly #sessionId: SessionId;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;

  constructor(
    store: EventStore,
    sessionId: SessionId,
    options: { clock?: () => Date; onEvent?: (event: SessionEvent) => void } = {},
  ) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
    if (!store.load(sessionId)) throw new Error(`Session ${sessionId} must exist before creating a Goal`);
  }

  create(contract: GoalContractInput, control: ControlGrant): GoalView {
    const goalId = createId("gol") as GoalId;
    this.#append("goal.created", {
      goalId,
      contractVersion: 1,
      objective: contract.objective,
      assertions: contract.assertions.map((assertion) => ({ ...assertion, required: assertion.required ?? true })),
      evidenceRequirements: (contract.evidenceRequirements ?? []).map((requirement) => ({
        ...requirement,
        kinds: [...requirement.kinds],
        minimum: requirement.minimum ?? 1,
      })),
      boundaries: [...(contract.boundaries ?? [])],
      resources: (contract.resources ?? []).map((resource) => ({ ...resource })),
      stagnation: contract.stagnation ?? { windowSteps: 5, maxEquivalentFailures: 3, onTrip: "park" },
    }, { kind: "user", id: control.issuedTo });
    this.#issueReceipt(goalId, "granted", control);
    return this.#goal(goalId);
  }

  recordEvidence(input: EvidenceInput): string {
    const evidenceId = createId("evi");
    this.#append("evidence.recorded", { evidenceId, ...input }, { kind: "evaluator", id: input.producer });
    return evidenceId;
  }

  async evaluate<Input>(options: {
    goalId: GoalId;
    runId: RunId;
    assertionId: string;
    evaluator: Evaluator<Input>;
    input: Input;
    calibration?: EvaluatorCalibrationRegistry;
    signal?: AbortSignal;
  }): Promise<EvaluationId> {
    const draft = await options.evaluator.evaluate(options.input, options.signal);
    const evaluationId = createId("evl") as EvaluationId;
    let calibration: "trusted" | "untrusted" | "not-required" = "not-required";
    let version = options.evaluator.version;
    if (options.evaluator.kind === "semantic") {
      const semantic = options.evaluator as SemanticEvaluator<Input>;
      version = evaluatorIdentity(semantic.identity);
      calibration = options.calibration?.status(semantic.identity, this.#clock()).trusted ? "trusted" : "untrusted";
    }
    const outcome = options.evaluator.kind === "semantic" && calibration === "untrusted" ? "unknown" : draft.outcome;
    this.#append("evaluation.completed", {
      runId: options.runId,
      goalId: options.goalId,
      evaluationId,
      assertionId: options.assertionId,
      evaluatorKind: options.evaluator.kind,
      evaluatorVersion: version,
      calibration,
      outcome,
      reportedOutcome: draft.outcome,
      evidenceRefs: [...draft.evidenceRefs],
      reproducible: draft.reproducible,
      ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
    }, { kind: "evaluator", id: version });
    return evaluationId;
  }

  consumeResource(goalId: GoalId, resourceName: ResourceName, amount: number, reason: string, runId?: RunId): {
    consumed: number;
    limit: number;
    converging: boolean;
    exhausted: boolean;
  } {
    const before = this.#goal(goalId).resources[resourceName];
    if (!before) throw new Error(`${resourceName} is not budgeted`);
    this.#append("goal.resource.consumed", {
      goalId,
      ...(runId === undefined ? {} : { runId }),
      resource: resourceName,
      amount,
      reason,
    }, { kind: "runtime", id: "resource_envelope" });
    let current = this.#goal(goalId).resources[resourceName];
    if (!current) throw new Error(`${resourceName} disappeared from the Goal`);
    const ratio = current.consumed / current.limit;
    if (ratio >= 0.75 && !current.converging) {
      this.#append("goal.convergence.entered", { goalId, resource: resourceName, consumedRatio: ratio }, { kind: "runtime", id: "resource_envelope" });
      current = this.#goal(goalId).resources[resourceName];
      if (!current) throw new Error(`${resourceName} disappeared from the Goal`);
    }
    if (ratio >= 1) {
      if (runId) this.#parkRunIfSafe(runId, "budget", `${resourceName} budget exhausted at ${current.consumed}/${current.limit}`);
      this.changeState(goalId, "paused", `${resourceName} budget exhausted`);
    }
    return { consumed: current.consumed, limit: current.limit, converging: current.converging, exhausted: ratio >= 1 };
  }

  recordFailure(options: FailureFingerprintInput & { goalId: GoalId; runId: RunId; stepId: StepId; progress?: boolean }): {
    fingerprint: string;
    tripped: boolean;
    decision?: "change-strategy" | "narrow-scope" | "park";
  } {
    const fingerprint = failureFingerprint(options);
    this.#append("goal.failure.recorded", {
      goalId: options.goalId,
      runId: options.runId,
      stepId: options.stepId,
      assertionId: options.assertionId,
      failureFingerprint: fingerprint,
      progress: options.progress ?? false,
    }, { kind: "runtime", id: "stagnation_detector" });
    const goal = this.#goal(options.goalId);
    const recent = goal.failures.slice(-goal.stagnation.windowSteps);
    const equivalent = recent.filter((failure) => failure.failureFingerprint === fingerprint).length;
    if (recent.some((failure) => failure.progress) || equivalent < goal.stagnation.maxEquivalentFailures) {
      return { fingerprint, tripped: false };
    }
    const decision = goal.stagnation.onTrip;
    this.#append("goal.stagnation.detected", {
      goalId: options.goalId,
      runId: options.runId,
      failureFingerprint: fingerprint,
      equivalentFailures: equivalent,
      decision,
    }, { kind: "runtime", id: "stagnation_detector" });
    if (decision === "park") {
      this.#parkRunIfSafe(options.runId, "stagnation", `${equivalent} equivalent failures without progress`);
      this.changeState(options.goalId, "paused", "Repeated equivalent failures without progress");
    }
    return { fingerprint, tripped: true, decision };
  }

  complete(goalId: GoalId, evaluationIds: readonly EvaluationId[], control: ControlGrant): GoalView {
    this.#append("goal.state.changed", {
      goalId,
      state: "complete",
      reason: "All required assertions and evidence passed",
      evaluationIds: [...evaluationIds],
    }, { kind: "runtime", id: "goal_engine" });
    this.#issueReceipt(goalId, "settled", control, "complete");
    return this.#goal(goalId);
  }

  changeState(goalId: GoalId, state: Exclude<GoalState, "complete">, reason: string): GoalView {
    this.#append("goal.state.changed", { goalId, state, reason }, { kind: "user", id: "goal_controller" });
    return this.#goal(goalId);
  }

  #issueReceipt(goalId: GoalId, phase: "granted" | "settled", control: ControlGrant, outcome?: GoalState): void {
    const goal = this.#goal(goalId);
    this.#append("control.receipt.issued", {
      receiptId: createId("rcp"),
      goalId,
      phase,
      issuedTo: control.issuedTo,
      startRight: control.startRight,
      stopRight: control.stopRight,
      acceptanceRight: control.acceptanceRight,
      delegationRight: control.delegationRight,
      actionLeaseIds: [...control.actionLeaseIds],
      boundaries: [...goal.boundaries],
      resources: Object.entries(goal.resources).map(([resource, value]) => ({
        resource,
        limit: value?.limit ?? 0,
        consumed: value?.consumed ?? 0,
        unit: value?.unit ?? "unknown",
      })),
      ...(outcome === undefined ? {} : { outcome }),
    }, { kind: "runtime", id: "control_receipt" });
  }

  #parkRunIfSafe(runId: RunId, reason: "budget" | "stagnation", detail: string): void {
    const view = this.#view();
    const run = view.runs[runId];
    if (!run || run.status !== "active") return;
    const runningStep = run.stepOrder.some((stepId) => run.steps[stepId]?.status === "running");
    const unsettled = Object.values(run.actions).some((action) => !["denied", "completed", "failed", "cancelled", "indeterminate"].includes(action.status));
    if (runningStep || unsettled) throw new Error(`Run ${runId} is not at a safe park boundary`);
    this.#append("run.parked", { runId, reason, detail }, { kind: "runtime", id: "goal_engine" });
  }

  #goal(goalId: GoalId): GoalView {
    const goal = this.#view().goals[goalId];
    if (!goal) throw new Error(`Goal ${goalId} does not exist`);
    return goal;
  }

  #view(): SessionView {
    const view = this.#store.load(this.#sessionId);
    if (!view) throw new Error(`Session ${this.#sessionId} does not exist`);
    return view;
  }

  #append(type: SessionEvent["type"], data: unknown, actor: SessionEvent["actor"]): SessionEvent {
    const stream = this.#store.read(this.#sessionId);
    const event = parseSessionEvent({
      schemaVersion: 1,
      eventId: createId("evt"),
      sessionId: this.#sessionId,
      sequence: stream.version + 1,
      occurredAt: this.#clock().toISOString(),
      actor,
      ...(stream.events.at(-1)?.eventId ? { causationId: stream.events.at(-1)?.eventId } : {}),
      type,
      data,
    });
    this.#store.append(this.#sessionId, stream.version, [event]);
    this.#onEvent?.(event);
    return event;
  }
}
