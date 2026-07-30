import type {
  ActionId,
  EvidenceId,
  EvaluationId,
  GoalId,
  MemoryId,
  MemoryActivation,
  MemoryScope,
  PlanId,
  PlanItemId,
  QuestionId,
  ReceiptId,
  RunId,
  SessionEvent,
  SessionId,
  StepId,
  TaskId,
  WorkItemId,
  WorkPlanId,
} from "@civaapple/qi-protocol";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import type { ContextBlockStats } from "@civaapple/qi-ai/context";
import { StateTransitionError } from "./errors.js";

export type SessionMode = "ask" | "plan" | "agent";

export type RunStatus = "triggered" | "active" | "parked" | "completed" | "failed" | "cancelled";
export type StepStatus = "running" | "completed";
export type ActionStatus =
  | "proposed"
  | "awaiting-authority"
  | "granted"
  | "denied"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export interface StepView {
  stepId: StepId;
  status: StepStatus;
  finishReason?: "action-requested" | "response" | "handoff" | "error";
  compactions?: Array<{
    sourceStepId: StepId;
    artifactRef: string;
    originalEstimatedTokens: number;
    compactedEstimatedTokens: number;
    messageCount: number;
    reason: "pressure" | "hard-limit";
  }>;
  context?: {
    includedBlockIds: string[];
    omittedBlockIds: string[];
    blockStats?: ContextBlockStats[];
    estimatedTokens: number;
    budgetTokens: number;
  };
  model?: {
    requestId: string;
    provider: string;
    model: string;
    finishReason: "stop" | "actions" | "length";
    text: string;
    reasoning?: string;
  };
  rejectedActionCalls?: Array<{
    callId: string;
    toolName: string;
    errorCode: "TOOL_INPUT" | "ACTION_BATCH_LIMIT";
    reason: string;
  }>;
}

export interface ActionView {
  actionId: ActionId;
  stepId: StepId;
  toolName: string;
  effect: "read" | "write" | "execute" | "publish" | "spend";
  status: ActionStatus;
  leaseId?: string;
  terminalDetail?: string;
  resources: string[];
  policyTrace?: Array<{ leaseId: string; matched: boolean; reason: string }>;
  freshnessRebase?: {
    priorActionId: ActionId;
    resource: string;
    originalExpectedSha256: string;
    effectiveExpectedSha256: string;
  };
}

export interface EvaluationView {
  evaluationId: EvaluationId;
  assertionId: string;
  evaluatorKind: "deterministic" | "semantic" | "human";
  evaluatorVersion: string;
  calibration: "trusted" | "untrusted" | "not-required";
  outcome: "pass" | "fail" | "unknown";
  evidenceRefs: string[];
  goalId?: GoalId;
  reportedOutcome?: "pass" | "fail" | "unknown";
  reproducible?: boolean;
  confidence?: number;
}

export type GoalState = "active" | "paused" | "blocked" | "complete" | "cancelled";
export type ResourceName = "token" | "wallTime" | "money" | "attempts" | "concurrency" | "context" | "risk" | "attention";
export type EvidenceKind = "deterministic" | "behavioral" | "semantic" | "human";

export interface GoalView {
  goalId: GoalId;
  contractVersion: number;
  objective: string;
  state: GoalState;
  assertions: Record<string, { assertionId: string; description: string; required: boolean }>;
  evidenceRequirements: Array<{ assertionId: string; kinds: EvidenceKind[]; minimum: number }>;
  boundaries: string[];
  resources: Partial<Record<ResourceName, { limit: number; consumed: number; unit: string; converging: boolean }>>;
  stagnation: { windowSteps: number; maxEquivalentFailures: number; onTrip: "change-strategy" | "narrow-scope" | "park" };
  failures: Array<{ runId: RunId; stepId: StepId; assertionId: string; failureFingerprint: string; progress: boolean }>;
  evaluations: Record<string, EvaluationView>;
  terminalReason?: string;
}

export interface EvidenceView {
  evidenceId: EvidenceId;
  goalId: GoalId;
  runId?: RunId;
  assertionId?: string;
  kind: EvidenceKind;
  artifactRef: string;
  description: string;
  producer: string;
  reproducible: boolean;
}

export interface ControlReceiptView {
  receiptId: ReceiptId;
  goalId: GoalId;
  phase: "granted" | "settled";
  issuedTo: string;
  startRight: "user" | "schedule" | "event" | "agent";
  stopRight: "user" | "contract" | "agent";
  acceptanceRight: "human" | "evaluator" | "agent";
  delegationRight: boolean;
  actionLeaseIds: string[];
  boundaries: string[];
  resources: Array<{ resource: ResourceName; limit: number; consumed: number; unit: string }>;
  outcome?: GoalState;
}

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "relational";
export type MemoryStatus = "candidate" | "accepted" | "disputed" | "forgotten";

export interface MemoryClaimView {
  memoryId: MemoryId;
  operationId?: string;
  layer: MemoryLayer;
  statement: string;
  scope: MemoryScope | string;
  provenance: Array<{ projectId?: string; sessionId: SessionId; eventId: string; sequence: number }>;
  confidence: number;
  sensitivity: "public" | "private" | "secret";
  validFrom: string;
  expiresAt?: string;
  contradictionOf?: MemoryId;
  derivedFromMemoryId?: MemoryId;
  requiresConfirmation: boolean;
  status: MemoryStatus;
  activation: MemoryActivation;
  confirmedBy?: string;
  statusReason?: string;
  correctionMemoryId?: MemoryId;
}

export interface ProcessTaskView {
  taskId: TaskId;
  runId: RunId;
  stepId: StepId;
  actionId: ActionId;
  command: string;
  args: string[];
  workdir: string;
  pid: number;
  startedAt: string;
  expiresAt: string;
  logRef: string;
  status: "running" | "stopping" | "exited" | "lost";
  exitCode?: number | null;
  terminalReason?: string;
}

export interface PlanItemView {
  planItemId: PlanItemId;
  title: string;
  description: string;
  verification?: string;
  dependsOn: PlanItemId[];
}

export interface PlanRevisionView {
  revision: number;
  format: "legacy_items" | "formal_markdown";
  title: string;
  overview: string;
  artifactRef: string;
  sha256: string;
  path: string;
  markdown?: string;
  items: PlanItemView[];
  sourceRunId?: RunId;
  recordedAt: string;
}

export interface PlanView {
  planId: PlanId;
  revisions: Record<number, PlanRevisionView>;
  latestRevision: number;
  acceptedRevision?: number;
}

export interface PlanReviewView {
  planId: PlanId;
  revision: number;
  status: "pending" | "accepted" | "rejected" | "revise";
  feedback?: string;
}

export interface ControlQuestionView {
  questionId: QuestionId;
  kind: "next_run" | "generic";
  prompt: string;
  choices: Array<{ id: string; label: string }>;
  status: "pending" | "answered" | "cancelled";
  planId?: PlanId;
  revision?: number;
  completedRunId?: RunId;
  nextPlanItemId?: PlanItemId;
  choiceId?: string;
}

export interface RunPlanBinding {
  planId: PlanId;
  revision: number;
  planItemId?: PlanItemId;
  continuationOf?: RunId;
}

export interface RunQuestionView {
  questionSetId: QuestionId;
  actionId: ActionId;
  stepId: StepId;
  questions: Array<{
    id: string;
    header: string;
    prompt: string;
    selection: "single" | "multiple" | "text";
    options: Array<{ id: string; label: string; description?: string }>;
    allowText: boolean;
  }>;
  status: "pending" | "answered" | "cancelled";
  answers?: Array<{
    questionId: string;
    selectedOptionIds: string[];
    text?: string;
    skipped: boolean;
  }>;
  reason?: string;
}

export interface WorkPlanView {
  workPlanId: WorkPlanId;
  latestRevision: number;
  revisions: Record<number, {
    revision: number;
    runId: RunId;
    stepId: StepId;
    actionId: ActionId;
    explanation?: string;
    sourcePlan?: { planId: PlanId; revision: number };
    items: Array<{
      workItemId: WorkItemId;
      step: string;
      status: "pending" | "in_progress" | "completed";
    }>;
    updatedAt: string;
  }>;
}

export interface RunView {
  runId: RunId;
  trigger: "user" | "timer" | "event" | "resume";
  input?: string;
  mode: SessionMode;
  planBinding?: RunPlanBinding;
  status: RunStatus;
  steps: Record<string, StepView>;
  stepOrder: StepId[];
  actions: Record<string, ActionView>;
  questions: Record<string, RunQuestionView>;
  questionOrder: QuestionId[];
  pendingQuestionSetId?: QuestionId;
  evaluations: Record<string, EvaluationView>;
  steering: Array<{ message: string; actorId: string }>;
  graph?: {
    graphId: string;
    graphVersion: number;
    currentNode: string;
    path: Array<{ nodeId: string; edgeId?: string; decision?: "deterministic" | "model" }>;
  };
  delegations: Record<string, {
    delegationId: string;
    childSessionId: SessionId;
    outcome: string;
    returnPolicy: "result" | "result+trace" | "evidence-only";
    status: "running" | "accepted" | "rejected" | "cancelled" | "timed_out" | "failed";
    depth: 1;
    receiptId: string;
    parentLeaseId: string;
    childLeaseId: string;
    childSubject: string;
    contextRefs: string[];
    contractRef: string;
    resourceEnvelope: Record<string, number>;
    workspaceBranch?: string;
    resultRef?: string;
    summaryRef?: string;
    evidenceRefs: string[];
    coordinationWallTimeMs?: number;
    reasons?: string[];
  }>;
  terminal?: {
    type: "parked" | "completed" | "failed" | "cancelled";
    reason: string;
    detail?: string;
  };
}

export interface WorkspaceMountView {
  mountId: string;
  path: string;
  mode: "read";
  source: "project_config" | "cli" | "grant" | "command";
  addedAt: string;
}

export interface SessionView {
  sessionId: SessionId;
  title?: string;
  createdAt: string;
  version: number;
  mode: SessionMode;
  mounts: Record<string, WorkspaceMountView>;
  mountOrder: string[];
  currentRunId?: RunId;
  runs: Record<string, RunView>;
  runOrder: RunId[];
  goals: Record<string, GoalView>;
  goalOrder: GoalId[];
  currentGoalId?: GoalId;
  evidence: Record<string, EvidenceView>;
  controlReceipts: Record<string, ControlReceiptView>;
  memories: Record<string, MemoryClaimView>;
  memoryOrder: MemoryId[];
  tasks: Record<string, ProcessTaskView>;
  taskOrder: TaskId[];
  plans: Record<string, PlanView>;
  planOrder: PlanId[];
  currentPlanId?: PlanId;
  workPlans: Record<string, WorkPlanView>;
  workPlanOrder: WorkPlanId[];
  currentWorkPlanId?: WorkPlanId;
  pendingReview?: PlanReviewView;
  pendingQuestion?: ControlQuestionView;
  presence: { state: "active" | "waiting" | "watching" | "sleeping" | "blocked"; reason: string; wakeAt?: string };
  attentionPolicy?: { timezone: string; quietStart: string; quietEnd: string; maxInterruptions: number; interruptions: number };
}

const terminalActionStatuses = new Set<ActionStatus>([
  "denied",
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);

function fail(code: string, message: string): never {
  throw new StateTransitionError(code, message);
}

function getRun(view: SessionView, runId: RunId): RunView {
  const run = view.runs[runId];
  if (!run) fail("RUN_NOT_FOUND", `Run ${runId} does not exist`);
  return run;
}

function getGoal(view: SessionView, goalId: GoalId): GoalView {
  const goal = view.goals[goalId];
  if (!goal) fail("GOAL_NOT_FOUND", `Goal ${goalId} does not exist`);
  return goal;
}

function getStep(run: RunView, stepId: StepId): StepView {
  const step = run.steps[stepId];
  if (!step) fail("STEP_NOT_FOUND", `Step ${stepId} does not exist in ${run.runId}`);
  return step;
}

function getAction(run: RunView, actionId: ActionId, stepId: StepId): ActionView {
  const action = run.actions[actionId];
  if (!action) fail("ACTION_NOT_FOUND", `Action ${actionId} does not exist in ${run.runId}`);
  if (action.stepId !== stepId) {
    fail("ACTION_STEP_MISMATCH", `Action ${actionId} belongs to ${action.stepId}, not ${stepId}`);
  }
  return action;
}

function requireActive(run: RunView): void {
  if (run.status !== "active") {
    fail("RUN_NOT_ACTIVE", `Run ${run.runId} is ${run.status}, not active`);
  }
}

function requireActionStatus(action: ActionView, expected: ActionStatus, code: string): void {
  if (action.status !== expected) {
    fail(code, `Action ${action.actionId} is ${action.status}, expected ${expected}`);
  }
}

function requireRunSettled(run: RunView): void {
  const activeStep = run.stepOrder.map((id) => run.steps[id]).find((step) => step?.status === "running");
  if (activeStep) fail("STEP_STILL_RUNNING", `Step ${activeStep.stepId} is still running`);

  const unsettled = Object.values(run.actions).find((action) => !terminalActionStatuses.has(action.status));
  if (unsettled) fail("ACTION_UNSETTLED", `Action ${unsettled.actionId} is still ${unsettled.status}`);
  const delegated = Object.values(run.delegations).find((delegation) => delegation.status === "running");
  if (delegated) fail("DELEGATION_UNSETTLED", `Delegation ${delegated.delegationId} is still running`);
  if (run.pendingQuestionSetId) {
    fail("RUN_QUESTION_PENDING", `Question set ${run.pendingQuestionSetId} is still pending`);
  }
}

function hasActiveTopLevelRun(view: SessionView): boolean {
  const current = view.currentRunId ? view.runs[view.currentRunId] : undefined;
  return current !== undefined && (current.status === "triggered" || current.status === "active");
}

/**
 * Hard projection allowlists for Ask/Plan. Kept intentionally separate from
 * `@civaapple/qi-agent/capability` mode-policy (Kernel must not depend on capability),
 * and locked in lockstep by `tests/session-mode.test.mjs`.
 */
export const KERNEL_ASK_MODE_TOOLS = [
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
  "memory",
] as const;

/** Plan-only tools beyond {@link KERNEL_ASK_MODE_TOOLS}. */
export const KERNEL_PLAN_MODE_EXTRA_TOOLS = ["plan_document", "ask_question", "delegate"] as const;

const askTools = new Set<string>(KERNEL_ASK_MODE_TOOLS);
const planOnlyTools = new Set<string>(KERNEL_PLAN_MODE_EXTRA_TOOLS);

function assertActionAllowedForMode(run: RunView, toolName: string, effect: ActionView["effect"]): void {
  if ((toolName === "plan_document" || toolName === "ask_question") && run.mode !== "plan") {
    fail("MODE_TOOL_DENIED", `${toolName} is only available in Plan mode`);
  }
  if (toolName === "update_plan" && run.mode !== "agent") {
    fail("MODE_TOOL_DENIED", "update_plan is only available in Agent mode");
  }
  if (run.mode === "agent") return;
  if (run.mode === "ask") {
    if (effect !== "read") fail("MODE_EFFECT_DENIED", `Ask mode denies ${effect} effects`);
    if (!askTools.has(toolName)) fail("MODE_TOOL_DENIED", `Ask mode denies tool ${toolName}`);
    return;
  }
  // plan
  if (planOnlyTools.has(toolName)) {
    if (toolName === "plan_document" && effect !== "read" && effect !== "write") {
      fail("MODE_EFFECT_DENIED", "plan_document must declare read or write effect");
    }
    if (toolName === "ask_question" && effect !== "read") {
      fail("MODE_EFFECT_DENIED", "ask_question must declare read effect");
    }
    if (toolName === "delegate" && effect !== "read") {
      fail("MODE_EFFECT_DENIED", "delegate must declare read effect");
    }
    return;
  }
  if (effect !== "read") fail("MODE_EFFECT_DENIED", `Plan mode denies ${effect} effects for ${toolName}`);
  if (!askTools.has(toolName)) fail("MODE_TOOL_DENIED", `Plan mode denies tool ${toolName}`);
}

function assertPlanBindingLegal(view: SessionView, binding: RunPlanBinding, mode: SessionMode): void {
  if (mode !== "agent") fail("PLAN_BINDING_MODE", "Plan-bound Runs must freeze Agent mode");
  const plan = view.plans[binding.planId];
  if (!plan) fail("PLAN_NOT_FOUND", `Plan ${binding.planId} does not exist`);
  if (plan.acceptedRevision !== binding.revision) {
    fail("PLAN_REVISION_NOT_ACCEPTED", `Plan revision ${binding.revision} is not accepted`);
  }
  const revision = plan.revisions[binding.revision];
  if (!revision) fail("PLAN_REVISION_NOT_FOUND", `Plan revision ${binding.revision} does not exist`);
  if (revision.format === "formal_markdown") {
    if (binding.planItemId !== undefined) {
      fail("FORMAL_PLAN_ITEM_BINDING", "Formal Plan Runs bind the whole revision, not a Plan item");
    }
  } else {
    if (!binding.planItemId || !revision.items.some((item) => item.planItemId === binding.planItemId)) {
      fail("PLAN_ITEM_NOT_FOUND", `Plan item ${binding.planItemId ?? "(missing)"} is not in revision ${binding.revision}`);
    }
  }
  const alreadyBound = view.runOrder.some((runId) => {
    const run = view.runs[runId];
    return (
      run?.planBinding?.planId === binding.planId &&
      run.planBinding.revision === binding.revision &&
      run.planBinding.planItemId === binding.planItemId &&
      (run.status === "triggered" || run.status === "active" || run.status === "completed" || run.status === "parked")
    );
  });
  if (alreadyBound) {
    fail("PLAN_ITEM_ALREADY_BOUND", `Plan item ${binding.planItemId} already has a non-failed Run`);
  }
  if (binding.continuationOf) {
    const prior = view.runs[binding.continuationOf];
    if (!prior) fail("CONTINUATION_RUN_NOT_FOUND", `Continuation run ${binding.continuationOf} does not exist`);
    if (!prior.terminal) fail("CONTINUATION_RUN_NOT_TERMINAL", `Continuation run ${binding.continuationOf} is not terminal`);
  }
}

function validateGoalTransition(
  view: SessionView,
  goal: GoalView,
  next: GoalState,
  evaluationIds: readonly EvaluationId[],
): void {
  const allowed: Record<GoalState, readonly GoalState[]> = {
    active: ["paused", "blocked", "complete", "cancelled"],
    paused: ["active", "blocked", "complete", "cancelled"],
    blocked: ["active", "cancelled"],
    complete: [],
    cancelled: [],
  };
  if (!allowed[goal.state].includes(next)) {
    fail("INVALID_GOAL_TRANSITION", `Goal ${goal.goalId} cannot move from ${goal.state} to ${next}`);
  }
  if (next !== "complete") return;

  const selected = evaluationIds.map((id) => {
    const evaluation = goal.evaluations[id];
    if (!evaluation) fail("EVALUATION_NOT_FOUND", `Goal evaluation ${id} does not exist`);
    return evaluation;
  });
  for (const assertion of Object.values(goal.assertions)) {
    if (!assertion.required) continue;
    const passing = selected.filter(
      (evaluation) => evaluation.assertionId === assertion.assertionId && evaluation.outcome === "pass",
    );
    if (passing.length === 0) {
      fail("GOAL_ASSERTION_NOT_PASSED", `Required assertion ${assertion.assertionId} has no passing evaluation`);
    }
    for (const requirement of goal.evidenceRequirements.filter(
      (candidate) => candidate.assertionId === assertion.assertionId,
    )) {
      const acceptedRefs = new Set(passing.flatMap((evaluation) => evaluation.evidenceRefs));
      const count = Object.values(view.evidence).filter(
        (evidence) =>
          evidence.goalId === goal.goalId &&
          evidence.assertionId === assertion.assertionId &&
          requirement.kinds.includes(evidence.kind) &&
          acceptedRefs.has(evidence.artifactRef),
      ).length;
      if (count < requirement.minimum) {
        fail(
          "GOAL_EVIDENCE_INSUFFICIENT",
          `${assertion.assertionId} has ${count}/${requirement.minimum} required evidence`,
        );
      }
    }
  }
}

function clone(view: SessionView): SessionView {
  return structuredClone(view);
}

export function applySessionEvent(current: SessionView | undefined, rawEvent: unknown): SessionView {
  const event = parseSessionEvent(rawEvent);

  if (!current) {
    if (event.type !== "session.created") {
      fail("SESSION_NOT_CREATED", "The first event must be session.created");
    }
    if (event.sequence !== 1) {
      fail("SEQUENCE_GAP", `First event sequence must be 1, received ${event.sequence}`);
    }
    return {
      sessionId: event.sessionId,
      ...(event.data.title === undefined ? {} : { title: event.data.title }),
      createdAt: event.occurredAt,
      version: 1,
      mode: event.data.mode ?? "agent",
      mounts: {},
      mountOrder: [],
      runs: {},
      runOrder: [],
      goals: {},
      goalOrder: [],
      evidence: {},
      controlReceipts: {},
      memories: {},
      memoryOrder: [],
      tasks: {},
      taskOrder: [],
      plans: {},
      planOrder: [],
      workPlans: {},
      workPlanOrder: [],
      presence: { state: "sleeping", reason: "Session created" },
    };
  }

  if (event.sessionId !== current.sessionId) {
    fail("SESSION_MISMATCH", `Event belongs to ${event.sessionId}, expected ${current.sessionId}`);
  }
  if (event.sequence !== current.version + 1) {
    fail("SEQUENCE_GAP", `Expected sequence ${current.version + 1}, received ${event.sequence}`);
  }
  if (event.type === "session.created") {
    fail("SESSION_ALREADY_CREATED", `Session ${current.sessionId} is already created`);
  }

  const view = clone(current);
  view.version = event.sequence;

  switch (event.type) {
    case "session.mode.changed": {
      if (event.data.from !== view.mode) {
        fail("MODE_FROM_MISMATCH", `Session mode is ${view.mode}, not ${event.data.from}`);
      }
      if (event.data.from === event.data.to) fail("MODE_UNCHANGED", "Mode change requires a different mode");
      if (hasActiveTopLevelRun(view)) {
        fail("MODE_CHANGE_WHILE_RUN_ACTIVE", "Cannot change mode while a top-level Run is active");
      }
      if (view.pendingReview?.status === "pending") {
        fail("MODE_CHANGE_WHILE_REVIEW_PENDING", "Settle or cancel the pending Plan review before changing mode");
      }
      if (view.pendingQuestion?.status === "pending") {
        fail("MODE_CHANGE_WHILE_QUESTION_PENDING", "Answer or cancel the pending Question before changing mode");
      }
      view.mode = event.data.to;
      break;
    }
    case "workspace.mount.added": {
      if (view.mounts[event.data.mountId]) {
        fail("MOUNT_ALREADY_PRESENT", `Mount ${event.data.mountId} is already present`);
      }
      if (event.data.mode !== "read") fail("MOUNT_MODE_UNSUPPORTED", "Only read mounts are supported");
      view.mounts[event.data.mountId] = {
        mountId: event.data.mountId,
        path: event.data.path,
        mode: "read",
        source: event.data.source,
        addedAt: event.occurredAt,
      };
      view.mountOrder.push(event.data.mountId);
      break;
    }
    case "workspace.mount.removed": {
      if (!view.mounts[event.data.mountId]) {
        fail("MOUNT_NOT_FOUND", `Mount ${event.data.mountId} does not exist`);
      }
      delete view.mounts[event.data.mountId];
      view.mountOrder = view.mountOrder.filter((id) => id !== event.data.mountId);
      break;
    }
    case "plan.revision.recorded": {
      if (view.mode !== "plan") fail("PLAN_REVISION_MODE", "Plan revisions may only be recorded in Plan mode");
      const format = event.data.format ?? "legacy_items";
      if (format === "formal_markdown") {
        if (!event.data.markdown) fail("FORMAL_PLAN_MARKDOWN_REQUIRED", "Formal Plan revision requires Markdown");
        if (event.data.items !== undefined) fail("FORMAL_PLAN_ITEMS_FORBIDDEN", "Formal Plan revision cannot carry Todo items");
      } else {
        if (!event.data.items?.length) fail("LEGACY_PLAN_ITEMS_REQUIRED", "Legacy Plan revision requires items");
        if (event.data.markdown !== undefined) fail("LEGACY_PLAN_MARKDOWN_FORBIDDEN", "Legacy Plan revision cannot carry Markdown");
      }
      let plan = view.plans[event.data.planId];
      if (!plan) {
        plan = { planId: event.data.planId, revisions: {}, latestRevision: 0 };
        view.plans[event.data.planId] = plan;
        view.planOrder.push(event.data.planId);
      }
      const expected = plan.latestRevision + 1;
      if (event.data.revision !== expected) {
        fail("PLAN_REVISION_GAP", `Expected plan revision ${expected}, received ${event.data.revision}`);
      }
      const itemIds = new Set<string>();
      for (const item of event.data.items ?? []) {
        if (itemIds.has(item.planItemId)) fail("PLAN_ITEM_DUPLICATE", `Duplicate plan item ${item.planItemId}`);
        itemIds.add(item.planItemId);
      }
      for (const item of event.data.items ?? []) {
        for (const dep of item.dependsOn ?? []) {
          if (!itemIds.has(dep)) fail("PLAN_ITEM_DEP_UNKNOWN", `Unknown dependency ${dep}`);
        }
      }
      plan.revisions[event.data.revision] = {
        revision: event.data.revision,
        format,
        title: event.data.title,
        overview: event.data.overview,
        artifactRef: event.data.artifactRef,
        sha256: event.data.sha256,
        path: event.data.path,
        ...(event.data.markdown === undefined ? {} : { markdown: event.data.markdown }),
        items: (event.data.items ?? []).map((item) => ({
          planItemId: item.planItemId,
          title: item.title,
          description: item.description,
          ...(item.verification === undefined ? {} : { verification: item.verification }),
          dependsOn: [...(item.dependsOn ?? [])],
        })),
        ...(event.data.sourceRunId === undefined ? {} : { sourceRunId: event.data.sourceRunId }),
        recordedAt: event.occurredAt,
      };
      plan.latestRevision = event.data.revision;
      view.currentPlanId = event.data.planId;
      if (view.pendingReview?.status === "pending") {
        fail("PLAN_REVIEW_STILL_PENDING", "Settle the pending Plan review before recording another revision");
      }
      break;
    }
    case "plan.review.requested": {
      if (view.pendingReview?.status === "pending") {
        fail("PLAN_REVIEW_ALREADY_PENDING", "A Plan review is already pending");
      }
      if (view.pendingQuestion?.status === "pending") {
        fail("QUESTION_STILL_PENDING", "Answer the pending Question before requesting Plan review");
      }
      const plan = view.plans[event.data.planId];
      if (!plan) fail("PLAN_NOT_FOUND", `Plan ${event.data.planId} does not exist`);
      if (plan.latestRevision !== event.data.revision || !plan.revisions[event.data.revision]) {
        fail("PLAN_REVISION_NOT_FOUND", `Plan revision ${event.data.revision} is not the latest recorded revision`);
      }
      view.pendingReview = {
        planId: event.data.planId,
        revision: event.data.revision,
        status: "pending",
      };
      view.presence = { state: "waiting", reason: "Awaiting Plan review" };
      break;
    }
    case "plan.review.settled": {
      const pending = view.pendingReview;
      if (!pending || pending.status !== "pending") fail("PLAN_REVIEW_NOT_PENDING", "No pending Plan review");
      if (pending.planId !== event.data.planId || pending.revision !== event.data.revision) {
        fail("PLAN_REVIEW_MISMATCH", "Settled review does not match the pending review");
      }
      pending.status = event.data.decision;
      if (event.data.feedback !== undefined) pending.feedback = event.data.feedback;
      const plan = view.plans[event.data.planId];
      if (!plan) fail("PLAN_NOT_FOUND", `Plan ${event.data.planId} does not exist`);
      if (event.data.decision === "accepted") {
        plan.acceptedRevision = event.data.revision;
      }
      delete view.pendingReview;
      if (view.presence.state === "waiting" && view.presence.reason === "Awaiting Plan review") {
        view.presence = { state: "sleeping", reason: "Plan review settled" };
      }
      break;
    }
    case "control.question.asked": {
      if (view.pendingQuestion?.status === "pending") {
        fail("QUESTION_ALREADY_PENDING", "A control Question is already pending");
      }
      if (view.pendingReview?.status === "pending") {
        fail("PLAN_REVIEW_STILL_PENDING", "Settle Plan review before asking a Question");
      }
      const choiceIds = new Set(event.data.choices.map((choice) => choice.id));
      if (choiceIds.size !== event.data.choices.length) {
        fail("QUESTION_CHOICE_DUPLICATE", "Question choices must be unique");
      }
      view.pendingQuestion = {
        questionId: event.data.questionId,
        kind: event.data.kind,
        prompt: event.data.prompt,
        choices: event.data.choices.map((choice) => ({ ...choice })),
        status: "pending",
        ...(event.data.planId === undefined ? {} : { planId: event.data.planId }),
        ...(event.data.revision === undefined ? {} : { revision: event.data.revision }),
        ...(event.data.completedRunId === undefined ? {} : { completedRunId: event.data.completedRunId }),
        ...(event.data.nextPlanItemId === undefined ? {} : { nextPlanItemId: event.data.nextPlanItemId }),
      };
      view.presence = { state: "waiting", reason: "Awaiting control Question answer" };
      break;
    }
    case "control.question.answered": {
      const pending = view.pendingQuestion;
      if (!pending || pending.status !== "pending") fail("QUESTION_NOT_PENDING", "No pending control Question");
      if (pending.questionId !== event.data.questionId) {
        fail("QUESTION_MISMATCH", "Answered Question does not match the pending Question");
      }
      if (!pending.choices.some((choice) => choice.id === event.data.choiceId)) {
        fail("QUESTION_CHOICE_UNKNOWN", `Unknown choice ${event.data.choiceId}`);
      }
      pending.status = "answered";
      pending.choiceId = event.data.choiceId;
      delete view.pendingQuestion;
      if (view.presence.state === "waiting" && view.presence.reason === "Awaiting control Question answer") {
        view.presence = { state: "sleeping", reason: "Control Question answered" };
      }
      break;
    }
    case "control.question.cancelled": {
      const pending = view.pendingQuestion;
      if (!pending || pending.status !== "pending") fail("QUESTION_NOT_PENDING", "No pending control Question");
      if (pending.questionId !== event.data.questionId) {
        fail("QUESTION_MISMATCH", "Cancelled Question does not match the pending Question");
      }
      pending.status = "cancelled";
      delete view.pendingQuestion;
      if (view.presence.state === "waiting" && view.presence.reason === "Awaiting control Question answer") {
        view.presence = { state: "sleeping", reason: "Control Question cancelled" };
      }
      break;
    }
    case "run.question.asked": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "running", "QUESTION_ACTION_NOT_RUNNING");
      if (action.toolName !== "ask_question") {
        fail("QUESTION_ACTION_TOOL", "Run Questions must belong to ask_question");
      }
      if (run.pendingQuestionSetId) {
        fail("RUN_QUESTION_ALREADY_PENDING", `Question set ${run.pendingQuestionSetId} is already pending`);
      }
      if (run.questions[event.data.questionSetId]) {
        fail("RUN_QUESTION_DUPLICATE", `Question set ${event.data.questionSetId} already exists`);
      }
      const questionIds = new Set<string>();
      for (const question of event.data.questions) {
        if (questionIds.has(question.id)) fail("RUN_QUESTION_ID_DUPLICATE", `Duplicate Question id ${question.id}`);
        questionIds.add(question.id);
        const optionIds = new Set(question.options.map((option) => option.id));
        if (optionIds.size !== question.options.length) {
          fail("RUN_QUESTION_OPTION_DUPLICATE", `Question ${question.id} has duplicate options`);
        }
        const allowText = question.allowText === true || question.selection === "text";
        if (question.selection === "text" && question.options.length > 0) {
          fail("RUN_QUESTION_TEXT_OPTIONS", `Text Question ${question.id} cannot declare options`);
        }
        if (question.selection !== "text" && question.options.length === 0 && !allowText) {
          fail("RUN_QUESTION_NO_INPUT", `Question ${question.id} has no answer input`);
        }
      }
      run.questions[event.data.questionSetId] = {
        questionSetId: event.data.questionSetId,
        actionId: event.data.actionId,
        stepId: event.data.stepId,
        questions: event.data.questions.map((question) => ({
          id: question.id,
          header: question.header,
          prompt: question.prompt,
          selection: question.selection,
          options: question.options.map((option) => ({ ...option })),
          allowText: question.allowText === true || question.selection === "text",
        })),
        status: "pending",
      };
      run.questionOrder.push(event.data.questionSetId);
      run.pendingQuestionSetId = event.data.questionSetId;
      view.presence = { state: "waiting", reason: "Awaiting Plan Question answers" };
      break;
    }
    case "run.question.answered": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (event.actor.kind !== "user") fail("RUN_QUESTION_ANSWER_ACTOR", "Run Question answers require a user");
      if (run.pendingQuestionSetId !== event.data.questionSetId) {
        fail("RUN_QUESTION_NOT_PENDING", `Question set ${event.data.questionSetId} is not pending`);
      }
      const questionSet = run.questions[event.data.questionSetId];
      if (!questionSet || questionSet.actionId !== event.data.actionId || questionSet.stepId !== event.data.stepId) {
        fail("RUN_QUESTION_MISMATCH", "Answered Question set does not match its Action");
      }
      const answers = new Map(event.data.answers.map((answer) => [answer.questionId, answer]));
      if (answers.size !== event.data.answers.length || answers.size !== questionSet.questions.length) {
        fail("RUN_QUESTION_ANSWER_COUNT", "Answers must cover every Question exactly once");
      }
      for (const question of questionSet.questions) {
        const answer = answers.get(question.id);
        if (!answer) fail("RUN_QUESTION_ANSWER_MISSING", `Question ${question.id} has no answer`);
        const selected = answer.selectedOptionIds ?? [];
        if (answer.skipped) {
          if (selected.length > 0 || answer.text !== undefined) {
            fail("RUN_QUESTION_SKIPPED_VALUE", `Skipped Question ${question.id} cannot carry an answer`);
          }
          continue;
        }
        const options = new Set(question.options.map((option) => option.id));
        if (selected.some((id) => !options.has(id))) {
          fail("RUN_QUESTION_OPTION_UNKNOWN", `Question ${question.id} selected an unknown option`);
        }
        if (question.selection === "single" && selected.length > 1) {
          fail("RUN_QUESTION_SINGLE_MULTIPLE", `Question ${question.id} allows one option`);
        }
        if (question.selection === "text" && selected.length > 0) {
          fail("RUN_QUESTION_TEXT_SELECTION", `Text Question ${question.id} cannot select options`);
        }
        if (answer.text !== undefined && !question.allowText) {
          fail("RUN_QUESTION_TEXT_FORBIDDEN", `Question ${question.id} does not allow text`);
        }
        if (selected.length === 0 && answer.text === undefined) {
          fail("RUN_QUESTION_ANSWER_EMPTY", `Question ${question.id} answer is empty`);
        }
      }
      questionSet.status = "answered";
      questionSet.answers = questionSet.questions.map((question) => {
        const answer = answers.get(question.id)!;
        return {
          questionId: answer.questionId,
          selectedOptionIds: [...(answer.selectedOptionIds ?? [])],
          ...(answer.text === undefined ? {} : { text: answer.text }),
          skipped: answer.skipped,
        };
      });
      delete run.pendingQuestionSetId;
      view.presence = { state: "active", reason: "Plan Question answered" };
      break;
    }
    case "run.question.cancelled": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (run.pendingQuestionSetId !== event.data.questionSetId) {
        fail("RUN_QUESTION_NOT_PENDING", `Question set ${event.data.questionSetId} is not pending`);
      }
      const questionSet = run.questions[event.data.questionSetId];
      if (!questionSet || questionSet.actionId !== event.data.actionId || questionSet.stepId !== event.data.stepId) {
        fail("RUN_QUESTION_MISMATCH", "Cancelled Question set does not match its Action");
      }
      questionSet.status = "cancelled";
      questionSet.reason = event.data.reason;
      delete run.pendingQuestionSetId;
      view.presence = { state: "active", reason: "Plan Question cancelled" };
      break;
    }
    case "work.plan.updated": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "running", "WORK_PLAN_ACTION_NOT_RUNNING");
      if (action.toolName !== "update_plan") fail("WORK_PLAN_ACTION_TOOL", "Work Plan updates require update_plan");
      const itemIds = new Set(event.data.items.map((item) => item.workItemId));
      const steps = new Set(event.data.items.map((item) => item.step));
      if (itemIds.size !== event.data.items.length) fail("WORK_ITEM_DUPLICATE", "Work item ids must be unique");
      if (steps.size !== event.data.items.length) fail("WORK_STEP_DUPLICATE", "Work item steps must be unique");
      if (event.data.items.filter((item) => item.status === "in_progress").length > 1) {
        fail("WORK_PLAN_MULTIPLE_ACTIVE", "At most one Work item may be in progress");
      }
      if (event.data.sourcePlan) {
        const source = view.plans[event.data.sourcePlan.planId]?.revisions[event.data.sourcePlan.revision];
        if (!source) fail("WORK_SOURCE_PLAN_NOT_FOUND", "Work Plan source Formal Plan does not exist");
      }
      let workPlan = view.workPlans[event.data.workPlanId];
      if (!workPlan) {
        if (event.data.revision !== 1) fail("WORK_PLAN_REVISION_GAP", "A new Work Plan starts at revision 1");
        workPlan = { workPlanId: event.data.workPlanId, latestRevision: 0, revisions: {} };
        view.workPlans[event.data.workPlanId] = workPlan;
        view.workPlanOrder.push(event.data.workPlanId);
      }
      if (event.data.revision !== workPlan.latestRevision + 1) {
        fail("WORK_PLAN_REVISION_GAP", `Expected Work Plan revision ${workPlan.latestRevision + 1}`);
      }
      workPlan.revisions[event.data.revision] = {
        revision: event.data.revision,
        runId: event.data.runId,
        stepId: event.data.stepId,
        actionId: event.data.actionId,
        ...(event.data.explanation === undefined ? {} : { explanation: event.data.explanation }),
        ...(event.data.sourcePlan === undefined ? {} : { sourcePlan: { ...event.data.sourcePlan } }),
        items: event.data.items.map((item) => ({ ...item })),
        updatedAt: event.occurredAt,
      };
      workPlan.latestRevision = event.data.revision;
      view.currentWorkPlanId = event.data.workPlanId;
      break;
    }
    case "memory.user.asserted":
      break;
    case "memory.candidate.created": {
      if (view.memories[event.data.memoryId]) fail("MEMORY_ALREADY_EXISTS", `Memory ${event.data.memoryId} exists`);
      const userScope = typeof event.data.scope !== "string" && event.data.scope.kind === "user";
      if (
        typeof event.data.scope !== "string"
        && event.data.provenance.some((reference) => reference.projectId === undefined)
      ) {
        fail("MEMORY_PROJECT_PROVENANCE_REQUIRED", "Structured Memory provenance requires an origin project");
      }
      if (
        (
          event.data.layer === "relational"
          || event.data.sensitivity !== "public"
          || userScope
          || event.data.contradictionOf !== undefined
        )
        && !event.data.requiresConfirmation
      ) {
        fail("MEMORY_CONFIRMATION_REQUIRED", "Relational and sensitive memories require confirmation");
      }
      if (event.data.contradictionOf) {
        const previous = view.memories[event.data.contradictionOf];
        if (previous && !sameMemoryScope(previous.scope, event.data.scope)) {
          fail("MEMORY_SCOPE_MISMATCH", "A correction must retain the original scope");
        }
      }
      view.memories[event.data.memoryId] = {
        memoryId: event.data.memoryId,
        ...(event.data.operationId === undefined ? {} : { operationId: event.data.operationId }),
        layer: event.data.layer,
        statement: event.data.statement,
        scope: typeof event.data.scope === "string" ? event.data.scope : { ...event.data.scope },
        provenance: event.data.provenance.map((reference) => ({ ...reference })),
        confidence: event.data.confidence,
        sensitivity: event.data.sensitivity,
        validFrom: event.data.validFrom,
        ...(event.data.expiresAt === undefined ? {} : { expiresAt: event.data.expiresAt }),
        ...(event.data.contradictionOf === undefined ? {} : { contradictionOf: event.data.contradictionOf }),
        ...(event.data.derivedFromMemoryId === undefined ? {} : { derivedFromMemoryId: event.data.derivedFromMemoryId }),
        requiresConfirmation: event.data.requiresConfirmation,
        status: "candidate",
        activation: "relevant",
      };
      view.memoryOrder.push(event.data.memoryId);
      break;
    }
    case "memory.accepted": {
      const memory = view.memories[event.data.memoryId];
      if (!memory) fail("MEMORY_NOT_FOUND", event.data.memoryId);
      if (memory.status !== "candidate") fail("MEMORY_NOT_CANDIDATE", `Memory ${memory.memoryId} is ${memory.status}`);
      if (event.actor.kind === "agent") fail("AGENT_CANNOT_ACCEPT_MEMORY", "An Agent cannot accept its own memory candidate");
      const userScope = typeof memory.scope !== "string" && memory.scope.kind === "user";
      if ((memory.requiresConfirmation || userScope) && (event.actor.kind !== "user" || event.actor.id !== event.data.confirmedBy)) {
        fail("MEMORY_CONFIRMATION_REQUIRED", `Memory ${memory.memoryId} requires explicit user confirmation`);
      }
      memory.status = "accepted";
      memory.confirmedBy = event.data.confirmedBy;
      break;
    }
    case "memory.disputed": {
      const memory = view.memories[event.data.memoryId];
      if (!memory) fail("MEMORY_NOT_FOUND", event.data.memoryId);
      if (event.actor.kind !== "user") {
        fail("MEMORY_DISPUTE_REQUIRES_USER", "Only the user may dispute or correct memory");
      }
      if (memory.status === "forgotten") fail("MEMORY_ALREADY_FORGOTTEN", memory.memoryId);
      memory.status = "disputed";
      memory.statusReason = event.data.reason;
      if (event.data.correctionMemoryId) memory.correctionMemoryId = event.data.correctionMemoryId;
      break;
    }
    case "memory.forgotten": {
      const memory = view.memories[event.data.memoryId];
      if (!memory) fail("MEMORY_NOT_FOUND", event.data.memoryId);
      if (event.actor.kind === "agent") fail("AGENT_CANNOT_FORGET_MEMORY", "An Agent cannot erase memory provenance");
      memory.status = "forgotten";
      memory.statusReason = event.data.reason;
      break;
    }
    case "memory.activation.changed": {
      const memory = view.memories[event.data.memoryId];
      if (!memory) fail("MEMORY_NOT_FOUND", event.data.memoryId);
      if (event.actor.kind !== "user") fail("MEMORY_ACTIVATION_REQUIRES_USER", "Only the user changes memory activation");
      if (memory.status !== "accepted") fail("MEMORY_NOT_ACCEPTED", `Memory ${memory.memoryId} is ${memory.status}`);
      if (typeof memory.scope === "string" || memory.scope.kind !== "user") {
        fail("MEMORY_ACTIVATION_SCOPE", "Only user-scoped memory can be always active");
      }
      if (event.data.activation === "always") {
        if (memory.statement.length > 1_000) {
          fail("MEMORY_ALWAYS_TOO_LARGE", "Always-active memory is limited to 1000 characters");
        }
        const activeCount = Object.values(view.memories)
          .filter((claim) => claim.memoryId !== memory.memoryId && claim.activation === "always" && claim.status === "accepted")
          .length;
        if (activeCount >= 4) fail("MEMORY_ALWAYS_LIMIT", "At most four user memories may be always active");
      }
      memory.activation = event.data.activation;
      break;
    }
    case "attention.policy.set":
      if (event.actor.kind !== "user") fail("ATTENTION_POLICY_REQUIRES_USER", "Only the user sets attention policy");
      view.attentionPolicy = { ...event.data, interruptions: 0 };
      break;
    case "attention.interruption.recorded":
      if (!view.attentionPolicy) fail("ATTENTION_POLICY_MISSING", "Set attention policy before recording an interruption");
      if (view.attentionPolicy.interruptions >= view.attentionPolicy.maxInterruptions) {
        fail("ATTENTION_BUDGET_EXHAUSTED", "Attention budget is exhausted");
      }
      view.attentionPolicy.interruptions += 1;
      break;
    case "presence.changed":
      view.presence = {
        state: event.data.state,
        reason: event.data.reason,
        ...(event.data.wakeAt === undefined ? {} : { wakeAt: event.data.wakeAt }),
      };
      break;
    case "goal.created": {
      if (view.goals[event.data.goalId]) fail("GOAL_ALREADY_EXISTS", `Goal ${event.data.goalId} already exists`);
      const active = view.currentGoalId ? view.goals[view.currentGoalId] : undefined;
      if (active?.state === "active") fail("GOAL_ALREADY_ACTIVE", `Goal ${active.goalId} is already active`);
      const assertions: GoalView["assertions"] = {};
      for (const assertion of event.data.assertions) {
        if (assertions[assertion.assertionId]) fail("ASSERTION_DUPLICATE", `Duplicate assertion ${assertion.assertionId}`);
        assertions[assertion.assertionId] = { ...assertion };
      }
      for (const requirement of event.data.evidenceRequirements) {
        if (!assertions[requirement.assertionId]) {
          fail("ASSERTION_NOT_FOUND", `Evidence requirement references ${requirement.assertionId}`);
        }
      }
      const resources: GoalView["resources"] = {};
      for (const resource of event.data.resources) {
        if (resources[resource.resource]) fail("RESOURCE_DUPLICATE", `Duplicate resource ${resource.resource}`);
        resources[resource.resource] = { limit: resource.limit, consumed: 0, unit: resource.unit, converging: false };
      }
      if (event.data.stagnation.maxEquivalentFailures > event.data.stagnation.windowSteps) {
        fail("INVALID_STAGNATION_POLICY", "Equivalent failure threshold cannot exceed the Step window");
      }
      view.goals[event.data.goalId] = {
        goalId: event.data.goalId,
        contractVersion: event.data.contractVersion,
        objective: event.data.objective,
        state: "active",
        assertions,
        evidenceRequirements: event.data.evidenceRequirements.map((requirement) => ({
          assertionId: requirement.assertionId,
          kinds: [...requirement.kinds],
          minimum: requirement.minimum,
        })),
        boundaries: [...event.data.boundaries],
        resources,
        stagnation: { ...event.data.stagnation },
        failures: [],
        evaluations: {},
      };
      view.goalOrder.push(event.data.goalId);
      view.currentGoalId = event.data.goalId;
      break;
    }
    case "evidence.recorded": {
      const goal = getGoal(view, event.data.goalId);
      if (view.evidence[event.data.evidenceId]) fail("EVIDENCE_ALREADY_EXISTS", `Evidence ${event.data.evidenceId} exists`);
      if (event.data.assertionId && !goal.assertions[event.data.assertionId]) {
        fail("ASSERTION_NOT_FOUND", `Evidence references ${event.data.assertionId}`);
      }
      view.evidence[event.data.evidenceId] = {
        evidenceId: event.data.evidenceId,
        goalId: event.data.goalId,
        ...(event.data.runId === undefined ? {} : { runId: event.data.runId }),
        ...(event.data.assertionId === undefined ? {} : { assertionId: event.data.assertionId }),
        kind: event.data.kind,
        artifactRef: event.data.artifactRef,
        description: event.data.description,
        producer: event.data.producer,
        reproducible: event.data.reproducible,
      };
      break;
    }
    case "goal.resource.consumed": {
      const goal = getGoal(view, event.data.goalId);
      if (goal.state !== "active") fail("GOAL_NOT_ACTIVE", `Goal ${goal.goalId} is ${goal.state}`);
      const resource = goal.resources[event.data.resource];
      if (!resource) fail("RESOURCE_NOT_BUDGETED", `${event.data.resource} is not in the Goal envelope`);
      resource.consumed += event.data.amount;
      break;
    }
    case "goal.convergence.entered": {
      const goal = getGoal(view, event.data.goalId);
      const resource = goal.resources[event.data.resource];
      if (!resource) fail("RESOURCE_NOT_BUDGETED", `${event.data.resource} is not in the Goal envelope`);
      const actual = resource.consumed / resource.limit;
      if (actual < 0.75 || Math.abs(actual - event.data.consumedRatio) > 1e-9) {
        fail("INVALID_CONVERGENCE_RATIO", `Reported ${event.data.consumedRatio}, actual ${actual}`);
      }
      if (resource.converging) fail("CONVERGENCE_ALREADY_ENTERED", `${event.data.resource} is already converging`);
      resource.converging = true;
      break;
    }
    case "goal.failure.recorded": {
      const goal = getGoal(view, event.data.goalId);
      if (goal.state !== "active") fail("GOAL_NOT_ACTIVE", `Goal ${goal.goalId} is ${goal.state}`);
      if (!goal.assertions[event.data.assertionId]) fail("ASSERTION_NOT_FOUND", event.data.assertionId);
      const run = getRun(view, event.data.runId);
      getStep(run, event.data.stepId);
      goal.failures.push({
        runId: event.data.runId,
        stepId: event.data.stepId,
        assertionId: event.data.assertionId,
        failureFingerprint: event.data.failureFingerprint,
        progress: event.data.progress,
      });
      break;
    }
    case "goal.stagnation.detected": {
      const goal = getGoal(view, event.data.goalId);
      if (event.data.decision !== goal.stagnation.onTrip) fail("STAGNATION_POLICY_MISMATCH", "Decision differs from contract");
      const recent = goal.failures.slice(-goal.stagnation.windowSteps);
      const equivalent = recent.filter((failure) => failure.failureFingerprint === event.data.failureFingerprint).length;
      if (recent.some((failure) => failure.progress) || equivalent < goal.stagnation.maxEquivalentFailures || equivalent !== event.data.equivalentFailures) {
        fail("STAGNATION_NOT_PROVEN", "Failure window does not prove stagnation");
      }
      break;
    }
    case "control.receipt.issued": {
      const goal = getGoal(view, event.data.goalId);
      if (view.controlReceipts[event.data.receiptId]) fail("RECEIPT_ALREADY_EXISTS", `Receipt ${event.data.receiptId} exists`);
      if (event.data.phase === "granted" && event.data.outcome !== undefined) fail("INVALID_RECEIPT_OUTCOME", "Granted receipt cannot settle an outcome");
      if (event.data.phase === "settled" && event.data.outcome === undefined) fail("RECEIPT_OUTCOME_REQUIRED", "Settled receipt requires an outcome");
      for (const snapshot of event.data.resources) {
        const resource = goal.resources[snapshot.resource];
        if (!resource || resource.limit !== snapshot.limit || resource.unit !== snapshot.unit || resource.consumed !== snapshot.consumed) {
          fail("RECEIPT_RESOURCE_MISMATCH", `Receipt does not match ${snapshot.resource}`);
        }
      }
      view.controlReceipts[event.data.receiptId] = {
        receiptId: event.data.receiptId,
        goalId: event.data.goalId,
        phase: event.data.phase,
        issuedTo: event.data.issuedTo,
        startRight: event.data.startRight,
        stopRight: event.data.stopRight,
        acceptanceRight: event.data.acceptanceRight,
        delegationRight: event.data.delegationRight,
        actionLeaseIds: [...event.data.actionLeaseIds],
        boundaries: [...event.data.boundaries],
        resources: event.data.resources.map((resource) => ({ ...resource })),
        ...(event.data.outcome === undefined ? {} : { outcome: event.data.outcome }),
      };
      break;
    }
    case "goal.state.changed": {
      const goal = getGoal(view, event.data.goalId);
      validateGoalTransition(view, goal, event.data.state, event.data.evaluationIds ?? []);
      goal.state = event.data.state;
      goal.terminalReason = event.data.reason;
      break;
    }
    case "run.triggered": {
      if (view.runs[event.data.runId]) fail("RUN_ALREADY_EXISTS", `Run ${event.data.runId} already exists`);
      const currentRun = view.currentRunId ? view.runs[view.currentRunId] : undefined;
      if (currentRun && (currentRun.status === "triggered" || currentRun.status === "active")) {
        fail("RUN_ALREADY_ACTIVE", `Run ${currentRun.runId} must stop before another run is triggered`);
      }
      const mode = event.data.mode ?? view.mode;
      if (event.data.mode !== undefined && event.data.mode !== view.mode) {
        fail("RUN_MODE_MISMATCH", `Run mode ${event.data.mode} does not match Session mode ${view.mode}`);
      }
      if (event.data.planBinding) {
        assertPlanBindingLegal(view, event.data.planBinding, mode);
      }
      view.runs[event.data.runId] = {
        runId: event.data.runId,
        trigger: event.data.trigger,
        ...(event.data.input === undefined ? {} : { input: event.data.input }),
        mode,
        ...(event.data.planBinding === undefined
          ? {}
          : {
              planBinding: {
                planId: event.data.planBinding.planId,
                revision: event.data.planBinding.revision,
                ...(event.data.planBinding.planItemId === undefined
                  ? {}
                  : { planItemId: event.data.planBinding.planItemId }),
                ...(event.data.planBinding.continuationOf === undefined
                  ? {}
                  : { continuationOf: event.data.planBinding.continuationOf }),
              },
            }),
        status: "triggered",
        steps: {},
        stepOrder: [],
        actions: {},
        questions: {},
        questionOrder: [],
        evaluations: {},
        steering: [],
        delegations: {},
      };
      view.runOrder.push(event.data.runId);
      view.currentRunId = event.data.runId;
      break;
    }
    case "run.started": {
      const run = getRun(view, event.data.runId);
      if (run.status !== "triggered") fail("RUN_CANNOT_START", `Run ${run.runId} is ${run.status}`);
      run.status = "active";
      break;
    }
    case "steering.received": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (event.actor.kind !== "user") fail("INVALID_STEERING_ACTOR", "Steering must be authored by a user");
      run.steering.push({ message: event.data.message, actorId: event.actor.id });
      break;
    }
    case "graph.node.entered": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (run.graph) fail("GRAPH_ALREADY_ENTERED", `Run ${run.runId} already entered graph ${run.graph.graphId}`);
      run.graph = {
        graphId: event.data.graphId,
        graphVersion: event.data.graphVersion,
        currentNode: event.data.nodeId,
        path: [{ nodeId: event.data.nodeId }],
      };
      break;
    }
    case "graph.transitioned": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const graph = run.graph;
      if (!graph) fail("GRAPH_NOT_ENTERED", `Run ${run.runId} has no graph`);
      if (graph.graphId !== event.data.graphId || graph.graphVersion !== event.data.graphVersion) {
        fail("GRAPH_IDENTITY_MISMATCH", "Graph route does not match the entered definition");
      }
      if (graph.currentNode !== event.data.from) fail("GRAPH_NODE_MISMATCH", `Graph is at ${graph.currentNode}, not ${event.data.from}`);
      graph.currentNode = event.data.to;
      graph.path.push({ nodeId: event.data.to, edgeId: event.data.edgeId, decision: event.data.decision });
      break;
    }
    case "graph.definition.updated": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const graph = run.graph;
      if (!graph) fail("GRAPH_NOT_ENTERED", `Run ${run.runId} has no graph`);
      if (graph.graphId !== event.data.graphId || graph.graphVersion !== event.data.fromVersion) {
        fail("GRAPH_IDENTITY_MISMATCH", "Graph update does not match the active definition");
      }
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "running", "GRAPH_UPDATE_ACTION_NOT_RUNNING");
      graph.graphVersion = event.data.toVersion;
      break;
    }
    case "delegation.created": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (event.data.depth !== 1) fail("DELEGATION_DEPTH_UNSUPPORTED", "Only depth=1 delegations are supported");
      if (run.delegations[event.data.delegationId]) fail("DELEGATION_ALREADY_EXISTS", `Delegation ${event.data.delegationId} exists`);
      run.delegations[event.data.delegationId] = {
        delegationId: event.data.delegationId,
        childSessionId: event.data.childSessionId,
        outcome: event.data.outcome,
        returnPolicy: event.data.returnPolicy,
        status: "running",
        depth: 1,
        receiptId: event.data.receiptId,
        parentLeaseId: event.data.parentLeaseId,
        childLeaseId: event.data.childLeaseId,
        childSubject: event.data.childSubject,
        contextRefs: [...event.data.contextRefs],
        contractRef: event.data.contractRef,
        resourceEnvelope: { ...event.data.resourceEnvelope },
        ...(event.data.workspaceBranch === undefined ? {} : { workspaceBranch: event.data.workspaceBranch }),
        evidenceRefs: [],
      };
      break;
    }
    case "delegation.returned": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const delegation = run.delegations[event.data.delegationId];
      if (!delegation) fail("DELEGATION_NOT_FOUND", `Delegation ${event.data.delegationId} does not exist`);
      if (delegation.childSessionId !== event.data.childSessionId) fail("DELEGATION_SESSION_MISMATCH", "Child Session mismatch");
      if (delegation.status !== "running") fail("DELEGATION_ALREADY_RETURNED", `Delegation ${event.data.delegationId} already returned`);
      delegation.status = event.data.outcome;
      delegation.evidenceRefs = [...event.data.evidenceRefs];
      delegation.coordinationWallTimeMs = event.data.coordinationWallTimeMs;
      if (event.data.resultRef !== undefined) delegation.resultRef = event.data.resultRef;
      if (event.data.summaryRef !== undefined) delegation.summaryRef = event.data.summaryRef;
      if (event.data.reasons !== undefined) delegation.reasons = [...event.data.reasons];
      break;
    }
    case "step.started": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (run.steps[event.data.stepId]) fail("STEP_ALREADY_EXISTS", `Step ${event.data.stepId} already exists`);
      requireRunSettled(run);
      run.steps[event.data.stepId] = { stepId: event.data.stepId, status: "running" };
      run.stepOrder.push(event.data.stepId);
      break;
    }
    case "step.completed": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const step = getStep(run, event.data.stepId);
      if (step.status !== "running") fail("STEP_ALREADY_COMPLETED", `Step ${step.stepId} already completed`);
      step.status = "completed";
      step.finishReason = event.data.finishReason;
      break;
    }
    case "context.compacted": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const step = getStep(run, event.data.stepId);
      if (step.status !== "running") fail("STEP_NOT_RUNNING", `Step ${step.stepId} is not running`);
      const source = getStep(run, event.data.sourceStepId);
      if (source.status !== "completed") {
        fail("COMPACTION_SOURCE_NOT_SETTLED", `Compaction source Step ${source.stepId} is not completed`);
      }
      if (event.data.compactedEstimatedTokens >= event.data.originalEstimatedTokens) {
        fail("COMPACTION_NOT_SMALLER", "Compacted context must use fewer estimated tokens than its source");
      }
      step.compactions ??= [];
      if (step.compactions.some((item) => item.sourceStepId === event.data.sourceStepId)) {
        fail("CONTEXT_ALREADY_COMPACTED", `Step ${event.data.sourceStepId} was already compacted at this boundary`);
      }
      step.compactions.push({
        sourceStepId: event.data.sourceStepId,
        artifactRef: event.data.artifactRef,
        originalEstimatedTokens: event.data.originalEstimatedTokens,
        compactedEstimatedTokens: event.data.compactedEstimatedTokens,
        messageCount: event.data.messageCount,
        reason: event.data.reason,
      });
      break;
    }
    case "context.compiled": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const step = getStep(run, event.data.stepId);
      if (step.status !== "running") fail("STEP_NOT_RUNNING", `Step ${step.stepId} is not running`);
      if (step.context) fail("CONTEXT_ALREADY_COMPILED", `Step ${step.stepId} already has compiled context`);
      if (event.data.blockStats) {
        const kinds = new Set(event.data.blockStats.map((item) => item.kind));
        if (kinds.size !== event.data.blockStats.length) {
          fail("CONTEXT_STATS_DUPLICATE_KIND", "Context block statistics must contain each kind at most once");
        }
        const includedTokens = event.data.blockStats.reduce(
          (sum, item) => sum + item.includedEstimatedTokens,
          0,
        );
        if (includedTokens > event.data.estimatedTokens) {
          fail("CONTEXT_STATS_EXCEED_TOTAL", "Context block token statistics exceed total estimated prompt tokens");
        }
        if (event.data.blockStats.some((item) => item.includedCount + item.omittedCount === 0)) {
          fail("CONTEXT_STATS_EMPTY_KIND", "Context block statistics cannot contain an empty kind");
        }
      }
      step.context = {
        includedBlockIds: [...event.data.includedBlockIds],
        omittedBlockIds: [...event.data.omittedBlockIds],
        ...(event.data.blockStats === undefined
          ? {}
          : { blockStats: event.data.blockStats.map((item) => ({ ...item })) }),
        estimatedTokens: event.data.estimatedTokens,
        budgetTokens: event.data.budgetTokens,
      };
      break;
    }
    case "model.completed": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const step = getStep(run, event.data.stepId);
      if (step.status !== "running") fail("STEP_NOT_RUNNING", `Step ${step.stepId} is not running`);
      if (step.model) fail("MODEL_ALREADY_COMPLETED", `Step ${step.stepId} already has model output`);
      step.model = {
        requestId: event.data.requestId,
        provider: event.data.provider,
        model: event.data.model,
        finishReason: event.data.finishReason,
        text: event.data.text,
        ...(event.data.reasoning === undefined ? {} : { reasoning: event.data.reasoning }),
      };
      break;
    }
    case "model.action.rejected": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const step = getStep(run, event.data.stepId);
      if (step.status !== "running") fail("STEP_NOT_RUNNING", `Step ${step.stepId} is not running`);
      if (!step.model) fail("MODEL_NOT_COMPLETED", `Step ${step.stepId} has no completed model output`);
      step.rejectedActionCalls ??= [];
      if (step.rejectedActionCalls.some((call) => call.callId === event.data.callId)) {
        fail("MODEL_ACTION_ALREADY_REJECTED", `Model call ${event.data.callId} was already rejected`);
      }
      step.rejectedActionCalls.push({
        callId: event.data.callId,
        toolName: event.data.toolName,
        errorCode: event.data.errorCode,
        reason: event.data.reason,
      });
      break;
    }
    case "action.proposed": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const step = getStep(run, event.data.stepId);
      if (step.status !== "running") fail("STEP_NOT_RUNNING", `Step ${step.stepId} is not running`);
      if (run.actions[event.data.actionId]) fail("ACTION_ALREADY_EXISTS", `Action ${event.data.actionId} already exists`);
      assertActionAllowedForMode(run, event.data.toolName, event.data.effect);
      run.actions[event.data.actionId] = {
        actionId: event.data.actionId,
        stepId: event.data.stepId,
        toolName: event.data.toolName,
        effect: event.data.effect,
        resources: [...(event.data.resources ?? [])],
        status: "proposed",
      };
      break;
    }
    case "action.freshness.rebased": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "proposed", "ACTION_REBASE_TOO_LATE");
      if (action.freshnessRebase) fail("ACTION_ALREADY_REBASED", `Action ${action.actionId} was already rebased`);
      const prior = getAction(run, event.data.priorActionId, event.data.stepId);
      requireActionStatus(prior, "completed", "ACTION_REBASE_PRIOR_NOT_COMPLETED");
      if (action.toolName !== "edit" || prior.toolName !== "edit") {
        fail("ACTION_REBASE_TOOL_INVALID", "Freshness rebase requires an edit after a completed edit");
      }
      if (
        action.effect !== "write"
        || prior.effect !== "write"
        || action.resources.length !== 1
        || prior.resources.length !== 1
        || action.resources[0] !== event.data.resource
        || prior.resources[0] !== event.data.resource
      ) {
        fail("ACTION_REBASE_RESOURCE_INVALID", "Freshness rebase requires the same single write resource");
      }
      if (event.data.originalExpectedSha256 === event.data.effectiveExpectedSha256) {
        fail("ACTION_REBASE_NO_CHANGE", "Freshness rebase must change the expected digest");
      }
      action.freshnessRebase = {
        priorActionId: event.data.priorActionId,
        resource: event.data.resource,
        originalExpectedSha256: event.data.originalExpectedSha256,
        effectiveExpectedSha256: event.data.effectiveExpectedSha256,
      };
      break;
    }
    case "authority.requested": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "proposed", "AUTHORITY_ALREADY_REQUESTED");
      action.status = "awaiting-authority";
      break;
    }
    case "authority.granted": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "awaiting-authority", "AUTHORITY_NOT_REQUESTED");
      action.status = "granted";
      action.leaseId = event.data.leaseId;
      if (event.data.policyTrace) action.policyTrace = event.data.policyTrace.map((entry) => ({ ...entry }));
      break;
    }
    case "authority.denied": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "awaiting-authority", "AUTHORITY_NOT_REQUESTED");
      action.status = "denied";
      action.terminalDetail = event.data.reason;
      if (event.data.policyTrace) action.policyTrace = event.data.policyTrace.map((entry) => ({ ...entry }));
      break;
    }
    case "action.started": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "granted", "ACTION_NOT_GRANTED");
      action.status = "running";
      break;
    }
    case "task.started": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      requireActionStatus(action, "running", "TASK_ACTION_NOT_RUNNING");
      if (view.tasks[event.data.taskId]) fail("TASK_ALREADY_EXISTS", `Task ${event.data.taskId} already exists`);
      if (Date.parse(event.data.expiresAt) <= Date.parse(event.occurredAt)) {
        fail("TASK_EXPIRY_INVALID", `Task ${event.data.taskId} must expire after it starts`);
      }
      view.tasks[event.data.taskId] = {
        taskId: event.data.taskId,
        runId: event.data.runId,
        stepId: event.data.stepId,
        actionId: event.data.actionId,
        command: event.data.command,
        args: [...event.data.args],
        workdir: event.data.workdir,
        pid: event.data.pid,
        startedAt: event.occurredAt,
        expiresAt: event.data.expiresAt,
        logRef: event.data.logRef,
        status: "running",
      };
      view.taskOrder.push(event.data.taskId);
      break;
    }
    case "task.stop.requested": {
      const task = view.tasks[event.data.taskId];
      if (!task) fail("TASK_NOT_FOUND", `Task ${event.data.taskId} does not exist`);
      if (task.status !== "running") fail("TASK_NOT_RUNNING", `Task ${task.taskId} is ${task.status}`);
      task.status = "stopping";
      task.terminalReason = event.data.reason;
      break;
    }
    case "task.exited": {
      const task = view.tasks[event.data.taskId];
      if (!task) fail("TASK_NOT_FOUND", `Task ${event.data.taskId} does not exist`);
      if (task.status !== "running" && task.status !== "stopping") {
        fail("TASK_ALREADY_TERMINAL", `Task ${task.taskId} is ${task.status}`);
      }
      task.status = "exited";
      task.exitCode = event.data.exitCode;
      task.terminalReason = event.data.reason;
      break;
    }
    case "task.lost": {
      const task = view.tasks[event.data.taskId];
      if (!task) fail("TASK_NOT_FOUND", `Task ${event.data.taskId} does not exist`);
      if (task.status !== "running" && task.status !== "stopping") {
        fail("TASK_ALREADY_TERMINAL", `Task ${task.taskId} is ${task.status}`);
      }
      task.status = "lost";
      task.terminalReason = event.data.reason;
      break;
    }
    case "action.completed":
    case "action.failed":
    case "action.cancelled":
    case "action.indeterminate": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      const action = getAction(run, event.data.actionId, event.data.stepId);
      const pendingRunQuestion = run.pendingQuestionSetId
        ? run.questions[run.pendingQuestionSetId]
        : undefined;
      if (pendingRunQuestion?.actionId === action.actionId) {
        fail("RUN_QUESTION_PENDING", `Question set ${pendingRunQuestion.questionSetId} must settle before its Action`);
      }
      if (event.type === "action.cancelled" && action.status === "granted") {
        // A persisted grant can be cancelled during recovery when executor entry was
        // never durably recorded. Other terminal outcomes still require running.
      } else {
        requireActionStatus(action, "running", "ACTION_NOT_RUNNING");
      }
      const terminal = event.type.slice("action.".length) as "completed" | "failed" | "cancelled" | "indeterminate";
      action.status = terminal;
      if (event.type === "action.failed") action.terminalDetail = event.data.errorCode;
      if (event.type === "action.cancelled" || event.type === "action.indeterminate") {
        action.terminalDetail = event.data.reason;
      }
      break;
    }
    case "safety.redaction.applied": {
      // The immutable event is the audit record. It deliberately carries no
      // matched material and does not alter the domain projection.
      break;
    }
    case "evaluation.completed": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      if (run.evaluations[event.data.evaluationId]) {
        fail("EVALUATION_ALREADY_EXISTS", `Evaluation ${event.data.evaluationId} already exists`);
      }
      if (event.data.evaluatorKind === "semantic" && event.data.calibration !== "trusted" && event.data.outcome !== "unknown") {
        fail("UNCALIBRATED_SEMANTIC_RESULT", "An untrusted semantic evaluator may only emit unknown");
      }
      if (event.data.evaluatorKind !== "semantic" && event.data.calibration !== "not-required") {
        fail("INVALID_CALIBRATION", "Deterministic and human evaluators must use not-required calibration");
      }
      if (event.data.reportedOutcome !== undefined) {
        const mustDowngrade = event.data.evaluatorKind === "semantic" && event.data.calibration === "untrusted";
        if (mustDowngrade ? event.data.outcome !== "unknown" : event.data.outcome !== event.data.reportedOutcome) {
          fail("INVALID_EFFECTIVE_OUTCOME", "Effective outcome does not match calibration policy");
        }
      }
      const evaluation: EvaluationView = {
        evaluationId: event.data.evaluationId,
        assertionId: event.data.assertionId,
        evaluatorKind: event.data.evaluatorKind,
        evaluatorVersion: event.data.evaluatorVersion,
        calibration: event.data.calibration,
        outcome: event.data.outcome,
        evidenceRefs: [...event.data.evidenceRefs],
        ...(event.data.goalId === undefined ? {} : { goalId: event.data.goalId }),
        ...(event.data.reportedOutcome === undefined ? {} : { reportedOutcome: event.data.reportedOutcome }),
        ...(event.data.reproducible === undefined ? {} : { reproducible: event.data.reproducible }),
        ...(event.data.confidence === undefined ? {} : { confidence: event.data.confidence }),
      };
      if (event.data.goalId) {
        const goal = getGoal(view, event.data.goalId);
        if (!goal.assertions[event.data.assertionId]) fail("ASSERTION_NOT_FOUND", event.data.assertionId);
        for (const ref of event.data.evidenceRefs) {
          const evidence = Object.values(view.evidence).find((candidate) => candidate.artifactRef === ref);
          if (!evidence || evidence.goalId !== goal.goalId) fail("EVIDENCE_NOT_FOUND", `No Goal evidence for ${ref}`);
        }
        goal.evaluations[event.data.evaluationId] = evaluation;
      }
      run.evaluations[event.data.evaluationId] = evaluation;
      break;
    }
    case "run.parked": {
      const run = getRun(view, event.data.runId);
      if (run.status !== "triggered" && run.status !== "active") {
        fail("RUN_NOT_ACTIVE", `Run ${run.runId} is ${run.status}, not recoverable`);
      }
      if (run.status === "active") requireRunSettled(run);
      if (event.data.reason === "authority-denied" && !Object.values(run.actions).some((action) => action.status === "denied")) {
        fail("PARK_REASON_UNSUPPORTED", "authority-denied requires a denied action");
      }
      if (event.data.reason === "indeterminate-effect" && !Object.values(run.actions).some((action) => action.status === "indeterminate")) {
        fail("PARK_REASON_UNSUPPORTED", "indeterminate-effect requires an indeterminate action");
      }
      run.status = "parked";
      run.terminal = {
        type: "parked",
        reason: event.data.reason,
        ...(event.data.detail === undefined ? {} : { detail: event.data.detail }),
      };
      break;
    }
    case "run.completed": {
      const run = getRun(view, event.data.runId);
      requireActive(run);
      requireRunSettled(run);
      if (run.stepOrder.length === 0) {
        fail("STEP_REQUIRED", "A completed Run must contain at least one completed Step");
      }
      if (event.data.completionKind === "verified") {
        if (event.data.evaluationIds.length === 0) {
          fail("VERIFICATION_REQUIRED", "Verified completion requires at least one evaluation");
        }
        for (const evaluationId of event.data.evaluationIds) {
          const evaluation = run.evaluations[evaluationId];
          if (!evaluation) fail("EVALUATION_NOT_FOUND", `Evaluation ${evaluationId} does not exist`);
          if (evaluation.outcome !== "pass") {
            fail("VERIFICATION_NOT_PASSED", `Evaluation ${evaluationId} is ${evaluation.outcome}`);
          }
          if (evaluation.evaluatorKind === "semantic" && evaluation.calibration !== "trusted") {
            fail("EVALUATOR_NOT_TRUSTED", `Evaluation ${evaluationId} is not calibrated`);
          }
        }
      }
      run.status = "completed";
      run.terminal = { type: "completed", reason: event.data.completionKind };
      break;
    }
    case "run.failed": {
      const run = getRun(view, event.data.runId);
      if (run.status !== "triggered" && run.status !== "active") {
        fail("RUN_TERMINAL", `Run ${run.runId} is already ${run.status}`);
      }
      if (run.status === "active") requireRunSettled(run);
      run.status = "failed";
      run.terminal = { type: "failed", reason: event.data.code };
      break;
    }
    case "run.cancelled": {
      const run = getRun(view, event.data.runId);
      if (run.status !== "triggered" && run.status !== "active") {
        fail("RUN_TERMINAL", `Run ${run.runId} is already ${run.status}`);
      }
      if (run.status === "active") requireRunSettled(run);
      run.status = "cancelled";
      run.terminal = { type: "cancelled", reason: event.data.reason };
      break;
    }
  }

  return view;
}

function sameMemoryScope(left: MemoryScope | string, right: MemoryScope | string): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "session" && right.kind === "session") return left.sessionId === right.sessionId;
  if (left.kind === "project" && right.kind === "project") return left.projectId === right.projectId;
  return left.kind === "user" && right.kind === "user" && left.userId === right.userId;
}

export function replaySession(events: readonly unknown[]): SessionView {
  if (events.length === 0) fail("EMPTY_STREAM", "A Session stream cannot be empty");
  let view: SessionView | undefined;
  for (const event of events) view = applySessionEvent(view, event);
  if (!view) fail("EMPTY_STREAM", "A Session stream cannot be empty");
  return view;
}
