import type { ActionStatus, RunStatus, SessionView } from "@civaapple/qi-agent/kernel";
import type { SessionEvent } from "@civaapple/qi-protocol";

const FORMAL_PLAN_PREVIEW_LINES = 200;

export interface WebActionMilestones {
  proposed: number | undefined;
  authorityRequested: number | undefined;
  authorityGranted: number | undefined;
  started: number | undefined;
  terminal: number | undefined;
}

export interface WebWorkPlanItem {
  workItemId: string | undefined;
  step: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export interface WebAskQuestionOption {
  id: string;
  label: string;
}

export interface WebAskQuestionItem {
  id: string;
  header: string | undefined;
  prompt: string;
  selection: string | undefined;
  options: WebAskQuestionOption[];
  selectedOptionIds: string[];
  text: string | undefined;
  skipped: boolean;
}

export interface WebProcessOutput {
  command: string | undefined;
  exitCode: number | undefined;
  timedOut: boolean;
  stdout: string | undefined;
  stderr: string | undefined;
  workspaceChanged: boolean;
}

export interface WebPolicyTraceEntry {
  leaseId: string;
  matched: boolean;
  reason: string;
}

/**
 * Heuristic label for authority denials (read-only UX). Not a protocol outcome —
 * Once/Session/Project choices are not durable Session facts.
 */
export type WebDenialCategory =
  | "approval"
  | "user_deny"
  | "mode"
  | "path"
  | "lease"
  | "other";

/**
 * Heuristic label for settled tool failures (not authority.denied).
 * Isolation means OS sandbox / process-start policy signals in codes or streams —
 * not proof of which backend ran.
 */
export type WebFailureCategory =
  | "isolation"
  | "spawn"
  | "timeout"
  | "exit_nonzero"
  | "path_guard"
  | "sensitive_path"
  | "validation"
  | "other";

/**
 * Expected enforcement layers for a tool class (dual-path model).
 * `process-sandbox` means the class is eligible for ADR-0041 wrapping when available;
 * it does not claim a specific backend for this Action.
 */
export type WebGuardLayer = "capability" | "path-guard" | "process-sandbox" | "session-mode";

export interface WebActionProjection {
  actionId: string;
  stepId: string;
  toolName: string;
  effect: "read" | "write" | "execute" | "publish" | "spend";
  resources: string[];
  input: unknown;
  target: string;
  status: ActionStatus;
  errorCode: string | undefined;
  terminalDetail: string | undefined;
  /** Lease that authorized this Action when granted. */
  leaseId: string | undefined;
  /** Capability / approval policy trace from authority.granted or authority.denied. */
  policyTrace: WebPolicyTraceEntry[] | undefined;
  /** Present when status is denied (or terminalDetail looks like a denial). */
  denialCategory: WebDenialCategory | undefined;
  /** Present when status is failed (tool/settlement failure, not authority deny). */
  failureCategory: WebFailureCategory | undefined;
  /** Expected guard layers for this tool class (static product model). */
  guardLayers: WebGuardLayer[];
  /** ADR-0042 durable approval decision when present. */
  approval: WebApprovalDecision | undefined;
  result: unknown;
  resultSummary: string | undefined;
  /** File-mutation unified diff (edit/write/…) or Git workspaceChange.diff for process tools. */
  diff: string | undefined;
  diffTruncated: boolean;
  /** True when diff came from shell/script/verify Git fingerprinting, not a dedicated file tool. */
  gitWorkspaceChange: boolean;
  durationMs: number | undefined;
  recovered: boolean;
  milestones: WebActionMilestones;
  workPlanItems: WebWorkPlanItem[] | undefined;
  workPlanExplanation: string | undefined;
  askQuestions: WebAskQuestionItem[] | undefined;
  process: WebProcessOutput | undefined;
  /** Bounded metadata for an automatic `skill` Tool call; never the Skill body. */
  skillCall: WebSkillCall | undefined;
}

export interface WebStepProjection {
  stepId: string;
  index: number;
  status: "running" | "model-complete" | "settled";
  finishReason: "action-requested" | "response" | "handoff" | "error" | undefined;
  modelText: string | undefined;
  modelReasoning: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  context: {
    estimatedTokens: number;
    budgetTokens: number;
    omitted: number;
    omittedBlockIds: string[];
  } | undefined;
  rejectedCalls: Array<{ toolName: string; errorCode: string; reason: string }>;
  actions: WebActionProjection[];
  startSequence: number | undefined;
  endSequence: number | undefined;
}

export interface WebFormalPlanProjection {
  planId: string;
  revision: number;
  title: string;
  path: string;
  /** Bounded Markdown preview for narrative (not the Run input envelope). */
  markdownPreview: string | undefined;
  previewCollapsed: boolean;
}

export interface WebSkillUsage {
  name: string;
  scope: "workspace" | "user";
}

export interface WebSkillCall {
  name: string | undefined;
  scope: "workspace" | "user" | undefined;
  operation: string | undefined;
  status: ActionStatus;
  errorCode: string | undefined;
}

export interface WebWorkPlanSnapshot {
  workPlanId: string;
  revision: number;
  items: WebWorkPlanItem[];
  explanation: string | undefined;
}

export interface WebRunEnvironment {
  permissionMode: "manual" | "yolo" | "auto";
  sessionMode: string | undefined;
  sandbox:
    | {
        backend: string;
        strength: "full" | "reduced" | "none";
        status: string;
        wraps: string[];
        reason: string | undefined;
      }
    | undefined;
}

export interface WebApprovalDecision {
  decision: "allow" | "deny";
  scope: "once" | "session" | "project";
  source: string;
  pattern: {
    tool: string;
    effect: string;
    resourceClass: string;
  };
  reason: string;
}

export interface WebRunProjection {
  runId: string;
  trigger: "user" | "goal" | "timer" | "event" | "resume";
  input: string | undefined;
  /** Short label for sidebar / narrative title (Formal Plan aware). */
  displayTitle: string;
  /** Bounded explicit Skill provenance; Skill instructions are never projected. */
  skills: WebSkillUsage[];
  /** Bounded automatic `skill` Tool calls; Skill instructions are never projected. */
  skillCalls: WebSkillCall[];
  status: RunStatus;
  displayStatus: string;
  terminalReason: string | undefined;
  /** ADR-0042 durable environment disclosure when present. */
  environment: WebRunEnvironment | undefined;
  formalPlan: WebFormalPlanProjection | undefined;
  workPlan: WebWorkPlanSnapshot | undefined;
  steps: WebStepProjection[];
  startSequence: number | undefined;
  endSequence: number | undefined;
  /** ISO timestamp from `run.triggered` when present. */
  startedAt: string | undefined;
  endedAt: string | undefined;
  durationMs: number | undefined;
  summary: {
    stepCount: number;
    actionCount: number;
    completedActions: number;
    failedActions: number;
    recoveredFailures: number;
    deniedActions: number;
    /** Failed Actions whose failureCategory is isolation (sandbox / OS policy signals). */
    isolationFailures: number;
    /** Actions with durable authority.approval.decided. */
    approvalDecisions: number;
    effects: string[];
    tools: string[];
    skillStatus: "none" | "active" | "running" | "succeeded" | "failed" | "fallback";
  };
  /** Session image attachments for this Run (matches TUI `image #N · source`). */
  imageAttachments: WebImageAttachment[];
}

export interface WebImageAttachment {
  index: number;
  source: "clipboard" | "url" | "path";
  mediaType: string;
  width: number;
  height: number;
  originalArtifactRef: string;
}

export interface WebMountProjection {
  mountId: string;
  path: string;
  mode: "read";
  source: string;
  addedAt: string;
}

export interface WebSensitivePathGrantProjection {
  path: string;
  source: string;
  grantedAt: string;
}

export interface WebSessionProjection {
  sessionId: string;
  title: string | undefined;
  /** Session mode ask|plan|agent (orthogonal to permission mode, which is not a Session fact). */
  mode: SessionView["mode"];
  presence: SessionView["presence"];
  mounts: WebMountProjection[];
  sensitivePathGrants: WebSensitivePathGrantProjection[];
  runs: WebRunProjection[];
  currentRunId: string | undefined;
}

interface TimedProjection {
  startAt: string | undefined;
  endAt: string | undefined;
}

const terminalActionStatuses = new Set<ActionStatus>([
  "denied",
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);

export function projectWebSession(view: SessionView, events: readonly SessionEvent[]): WebSessionProjection {
  const runTiming = new Map<string, TimedProjection>();
  const actionTiming = new Map<string, TimedProjection>();
  const imageLabels = indexSessionImageLabels(view);
  const runs: WebRunProjection[] = view.runOrder.map((runId): WebRunProjection => {
    const run = view.runs[runId];
    if (!run) throw new Error(`Session projection references missing Run ${runId}`);
    const formalPlan = projectFormalPlan(view, run.planBinding);
    const workPlan = projectWorkPlan(view);
    const skills = projectSkillUsages(run);
    const imageAttachments = projectRunImageAttachments(run.content);
    const steps: WebStepProjection[] = run.stepOrder.map((stepId, index): WebStepProjection => {
      const step = run.steps[stepId];
      if (!step) throw new Error(`Run projection references missing Step ${stepId}`);
      const actions = Object.values(run.actions)
        .filter((action) => action.stepId === stepId)
        .map((action): WebActionProjection => ({
          actionId: action.actionId,
          stepId: action.stepId,
          toolName: action.toolName,
          effect: action.effect,
          resources: [...action.resources],
          input: undefined,
          target: action.resources[0] ?? action.toolName,
          status: action.status,
          errorCode: undefined,
          terminalDetail: action.terminalDetail,
          leaseId: action.leaseId,
          policyTrace: action.policyTrace
            ? action.policyTrace.map((entry) => ({ ...entry }))
            : undefined,
          denialCategory: action.status === "denied"
            ? classifyDenial(action.terminalDetail, action.policyTrace)
            : undefined,
          failureCategory: undefined,
          guardLayers: guardLayersForTool(action.toolName),
          approval: action.approval
            ? {
                decision: action.approval.decision,
                scope: action.approval.scope,
                source: action.approval.source,
                pattern: { ...action.approval.pattern },
                reason: action.approval.reason,
              }
            : undefined,
          result: undefined,
          resultSummary: undefined,
          diff: undefined,
          diffTruncated: false,
          gitWorkspaceChange: false,
          durationMs: undefined,
          recovered: action.status === "failed" && run.status === "completed",
          milestones: {
            proposed: undefined,
            authorityRequested: undefined,
            authorityGranted: undefined,
            started: undefined,
            terminal: undefined,
          },
          workPlanItems: undefined,
          workPlanExplanation: undefined,
          askQuestions: undefined,
          process: undefined,
          skillCall: undefined,
        }));
      return {
        stepId: step.stepId,
        index: index + 1,
        status: step.status === "running" ? "running" : actions.every((action) => terminalActionStatuses.has(action.status))
          ? "settled"
          : "model-complete",
        finishReason: step.finishReason,
        modelText: step.model?.text,
        modelReasoning: step.model?.reasoning,
        provider: step.model?.provider,
        model: step.model?.model,
        context: step.context
          ? {
              estimatedTokens: step.context.estimatedTokens,
              budgetTokens: step.context.budgetTokens,
              omitted: step.context.omittedBlockIds.length,
              omittedBlockIds: [...step.context.omittedBlockIds],
            }
          : undefined,
        rejectedCalls: (step.rejectedActionCalls ?? []).map((call) => ({
          toolName: call.toolName,
          errorCode: call.errorCode,
          reason: call.reason,
        })),
        actions,
        startSequence: undefined,
        endSequence: undefined,
      } satisfies WebStepProjection;
    });
    return {
      runId: run.runId,
      trigger: run.trigger,
      input: run.input,
      displayTitle: formalPlan
        ? `Accepted Plan · ${formalPlan.title} · rev ${formalPlan.revision}`
        : shorten(run.input?.trim() || `${run.trigger} Run`, 160),
      skills,
      skillCalls: [],
      status: run.status,
      displayStatus: run.status === "completed" && run.terminal?.reason === "response"
        ? "responded"
        : run.status === "completed" && run.terminal?.reason === "verified"
          ? "verified"
          : run.status,
      terminalReason: run.terminal?.reason,
      formalPlan,
      workPlan,
      environment: projectRunEnvironment(run),
      steps,
      startSequence: undefined,
      endSequence: undefined,
      startedAt: undefined,
      endedAt: undefined,
      durationMs: undefined,
      summary: {
        stepCount: steps.length,
        actionCount: 0,
        completedActions: 0,
        failedActions: 0,
        recoveredFailures: 0,
        deniedActions: 0,
        isolationFailures: 0,
        approvalDecisions: 0,
        effects: [],
        tools: [],
        skillStatus: skills.length > 0 ? "active" : "none",
      },
      imageAttachments,
    } satisfies WebRunProjection;
  });

  const runById = new Map(runs.map((run) => [run.runId, run]));
  const stepById = new Map(runs.flatMap((run) => run.steps.map((step) => [step.stepId, step] as const)));
  const actionById = new Map(
    runs.flatMap((run) => run.steps.flatMap((step) => step.actions.map((action) => [action.actionId, action] as const))),
  );

  for (const event of events) {
    switch (event.type) {
      case "run.triggered": {
        const run = runById.get(event.data.runId);
        if (run) {
          run.startSequence = event.sequence;
          runTiming.set(run.runId, { startAt: event.occurredAt, endAt: undefined });
        }
        break;
      }
      case "run.completed":
      case "run.failed":
      case "run.parked":
      case "run.cancelled": {
        const run = runById.get(event.data.runId);
        if (run) {
          run.endSequence = event.sequence;
          const timing = runTiming.get(run.runId) ?? { startAt: undefined, endAt: undefined };
          timing.endAt = event.occurredAt;
          runTiming.set(run.runId, timing);
        }
        break;
      }
      case "step.started": {
        const step = stepById.get(event.data.stepId);
        if (step) step.startSequence = event.sequence;
        break;
      }
      case "step.completed": {
        const step = stepById.get(event.data.stepId);
        if (step) step.endSequence = Math.max(step.endSequence ?? 0, event.sequence);
        break;
      }
      case "action.proposed": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.input = event.data.input;
          action.target = summarizeTarget(action.toolName, event.data.input, action.resources, imageLabels);
          if (action.toolName === "skill") action.skillCall = projectSkillCall(action, undefined);
          action.milestones.proposed = event.sequence;
          actionTiming.set(action.actionId, { startAt: event.occurredAt, endAt: undefined });
          enrichStructuredAction(action);
        }
        break;
      }
      case "authority.requested": {
        const action = actionById.get(event.data.actionId);
        if (action) action.milestones.authorityRequested = event.sequence;
        break;
      }
      case "authority.granted": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.milestones.authorityGranted = event.sequence;
          action.leaseId = event.data.leaseId;
          if (event.data.policyTrace) {
            action.policyTrace = event.data.policyTrace.map((entry) => ({ ...entry }));
          }
        }
        break;
      }
      case "authority.denied": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.terminalDetail = event.data.reason;
          if (event.data.policyTrace) {
            action.policyTrace = event.data.policyTrace.map((entry) => ({ ...entry }));
          }
          action.denialCategory = classifyDenial(event.data.reason, action.policyTrace);
          action.failureCategory = undefined;
          settleAction(action, event.sequence, event.occurredAt, actionTiming, stepById);
        }
        break;
      }
      case "authority.approval.decided": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.approval = {
            decision: event.data.decision,
            scope: event.data.scope,
            source: event.data.source,
            pattern: {
              tool: event.data.pattern.tool,
              effect: event.data.pattern.effect,
              resourceClass: event.data.pattern.resourceClass,
            },
            reason: event.data.reason,
          };
          if (event.data.decision === "deny") {
            action.denialCategory =
              event.data.source === "interactive"
                ? "user_deny"
                : event.data.source === "no-gate"
                  || event.data.source === "memory-session"
                  || event.data.source === "memory-project"
                  || event.data.source === "policy-deny"
                  ? "approval"
                  : classifyDenial(event.data.reason, action.policyTrace);
          }
        }
        break;
      }
      case "run.environment.disclosed": {
        const run = runById.get(event.data.runId);
        if (run) {
          run.environment = {
            permissionMode: event.data.permissionMode,
            sessionMode: event.data.sessionMode,
            sandbox: event.data.sandbox
              ? {
                  backend: event.data.sandbox.backend,
                  strength: event.data.sandbox.strength,
                  status: event.data.sandbox.status,
                  wraps: [...event.data.sandbox.wraps],
                  reason: event.data.sandbox.reason,
                }
              : undefined,
          };
        }
        break;
      }
      case "action.started": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.milestones.started = event.sequence;
          const timing = actionTiming.get(action.actionId) ?? { startAt: undefined, endAt: undefined };
          timing.startAt = event.occurredAt;
          actionTiming.set(action.actionId, timing);
        }
        break;
      }
      case "action.completed": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          const result = parseModelOutput(event.data.modelOutput);
          if (action.toolName === "skill") {
            action.skillCall = projectSkillCall(action, result);
            action.result = undefined;
            action.resultSummary = summarizeSkillCall(action.skillCall);
          } else {
            action.result = result;
            action.resultSummary = summarizeResult(action.toolName, action.result);
            if (action.toolName === "read_image") {
              action.target = summarizeReadImageTarget(action.input, action.result, imageLabels);
              action.resultSummary = summarizeReadImageResult(action.result) ?? action.resultSummary;
            }
          }
          applyDiffFields(action);
          enrichStructuredAction(action);
          action.failureCategory = undefined;
          settleAction(action, event.sequence, event.occurredAt, actionTiming, stepById);
        }
        break;
      }
      case "action.failed": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.errorCode = event.data.errorCode;
          const result = parseModelOutput(event.data.modelOutput);
          if (action.toolName === "skill") {
            action.skillCall = projectSkillCall(action, result);
            action.result = undefined;
            action.resultSummary = summarizeSkillCall(action.skillCall);
          } else {
            action.result = result;
            action.resultSummary = summarizeResult(action.toolName, action.result);
            if (action.toolName === "read_image") {
              action.target = summarizeReadImageTarget(action.input, action.result, imageLabels);
              action.resultSummary = summarizeReadImageResult(action.result) ?? action.resultSummary;
            }
          }
          applyDiffFields(action);
          enrichStructuredAction(action);
          action.failureCategory = classifyFailure({
            toolName: action.toolName,
            errorCode: action.errorCode,
            resultSummary: action.resultSummary,
            result: action.result,
            process: action.process,
            message: typeof event.data.modelOutput === "string" ? event.data.modelOutput : undefined,
          });
          settleAction(action, event.sequence, event.occurredAt, actionTiming, stepById);
        }
        break;
      }
      case "action.cancelled":
      case "action.indeterminate": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.terminalDetail = event.data.reason;
          settleAction(action, event.sequence, event.occurredAt, actionTiming, stepById);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const run of runs) {
    for (const step of run.steps) {
      step.actions.sort((left, right) => (left.milestones.proposed ?? 0) - (right.milestones.proposed ?? 0));
      if (step.actions.length > 0 && step.actions.every((action) => terminalActionStatuses.has(action.status))) {
        step.status = "settled";
      }
    }
    const actions = run.steps.flatMap((step) => step.actions);
    run.skillCalls = actions
      .map((action) => action.skillCall)
      .filter((call): call is WebSkillCall => call !== undefined);
    const skillFailure = run.skillCalls.some((call) => ["failed", "denied", "indeterminate"].includes(call.status))
      || (run.skills.length > 0 && actions.some((action) => action.status === "failed"));
    const skillStatus = skillFailure
      ? run.status === "completed" ? "fallback" : "failed"
      : run.skillCalls.some((call) => !terminalActionStatuses.has(call.status))
        ? "running"
        : run.skillCalls.length > 0
          ? "succeeded"
          : run.skills.length > 0 ? "active" : "none";
    run.summary = {
      stepCount: run.steps.length,
      actionCount: actions.length,
      completedActions: actions.filter((action) => action.status === "completed").length,
      failedActions: actions.filter((action) => action.status === "failed").length,
      recoveredFailures: actions.filter((action) => action.recovered).length,
      deniedActions: actions.filter((action) => action.status === "denied").length,
      isolationFailures: actions.filter((action) => action.failureCategory === "isolation").length,
      approvalDecisions: actions.filter((action) => action.approval !== undefined).length,
      effects: [...new Set(actions.map((action) => action.effect))],
      tools: [...new Set(actions.map((action) => action.toolName))],
      skillStatus,
    };
    const timing = runTiming.get(run.runId);
    run.startedAt = timing?.startAt;
    run.endedAt = timing?.endAt;
    run.durationMs = duration(timing?.startAt, timing?.endAt);
  }

  return {
    sessionId: view.sessionId,
    title: view.title,
    mode: view.mode,
    presence: view.presence,
    mounts: projectMounts(view),
    sensitivePathGrants: projectSensitivePathGrants(view),
    runs,
    currentRunId: view.currentRunId,
  };
}

function projectRunEnvironment(run: SessionView["runs"][string]): WebRunEnvironment | undefined {
  const environment = run.environment;
  if (!environment) return undefined;
  return {
    permissionMode: environment.permissionMode,
    sessionMode: environment.sessionMode,
    sandbox: environment.sandbox
      ? {
          backend: environment.sandbox.backend,
          strength: environment.sandbox.strength,
          status: environment.sandbox.status,
          wraps: [...environment.sandbox.wraps],
          reason: environment.sandbox.reason,
        }
      : undefined,
  };
}

function projectMounts(view: SessionView): WebMountProjection[] {
  return view.mountOrder
    .map((mountId) => view.mounts[mountId])
    .filter((mount): mount is NonNullable<typeof mount> => mount !== undefined)
    .map((mount) => ({
      mountId: mount.mountId,
      path: mount.path,
      mode: mount.mode,
      source: mount.source,
      addedAt: mount.addedAt,
    }));
}

function projectSensitivePathGrants(view: SessionView): WebSensitivePathGrantProjection[] {
  return view.sensitivePathGrantOrder
    .map((path) => view.sensitivePathGrants[path])
    .filter((grant): grant is NonNullable<typeof grant> => grant !== undefined)
    .map((grant) => ({
      path: grant.path,
      source: grant.source,
      grantedAt: grant.grantedAt,
    }));
}

/** Classify a denial reason for read-only Narrative labels. */
export function classifyDenial(
  reason: string | undefined,
  policyTrace: readonly WebPolicyTraceEntry[] | undefined,
  errorCode?: string | undefined,
): WebDenialCategory {
  const codes = `${errorCode ?? ""} ${(policyTrace ?? []).map((entry) => entry.leaseId).join(" ")}`.toUpperCase();
  const text = `${reason ?? ""} ${(policyTrace ?? []).map((entry) => `${entry.leaseId} ${entry.reason}`).join(" ")}`
    .toLowerCase();
  if (text.includes("user_deny") || text.includes("user denied")) return "user_deny";
  if (
    codes.includes("LEA_APPROVAL_POLICY")
    || text.includes("lea_approval_policy")
    || text.includes("manual approval")
    || text.includes("approval required")
    || text.includes("approval-memory")
    || text.includes("no interactive gate")
    || text.includes("approval policy")
  ) {
    return "approval";
  }
  if (
    text.includes("session mode")
    || text.includes("mode_den")
    || text.includes("not allowed in")
    || /\bask\b.*\bmode\b/.test(text)
    || text.includes("mode forbids")
    || text.includes("plan mode")
    || text.includes("ask mode")
  ) {
    return "mode";
  }
  if (
    codes.includes("PATH_")
    || codes.includes("MOUNT_")
    || codes.includes("SENSITIVE_")
    || codes.includes("PROTECTED_")
    || codes.includes("SYMLINK_")
    || text.includes("sensitive")
    || text.includes("outside workspace")
    || text.includes("outside the workspace")
    || text.includes("path grant")
    || text.includes("path guard")
    || text.includes(".ssh")
    || text.includes("protected path")
    || text.includes("mount not")
    || text.includes("unmounted")
    || text.includes("read-only mount")
    || text.includes("authorize with /add-dir")
  ) {
    return "path";
  }
  if (
    text.includes("lease")
    || text.includes("capability")
    || text.includes("not authorized")
    || text.includes("authority denied")
    || text.includes("no matching lease")
    || text.includes("default deny")
  ) {
    return "lease";
  }
  return "other";
}

/** Expected dual-layer guards for a tool (static product model). */
export function guardLayersForTool(toolName: string): WebGuardLayer[] {
  if (["shell", "script", "verify", "task"].includes(toolName)) {
    return ["capability", "path-guard", "process-sandbox"];
  }
  if (toolName === "skill") {
    return ["capability", "path-guard", "process-sandbox"];
  }
  if (["ask_question", "update_plan", "plan_document", "delegate"].includes(toolName)) {
    return ["session-mode", "capability"];
  }
  if (
    ["read", "edit", "write", "move", "remove", "find", "search", "git", "read_image", "artifact", "network"].includes(
      toolName,
    )
  ) {
    return ["capability", "path-guard"];
  }
  return ["capability"];
}

export function classifyFailure(input: {
  toolName: string;
  errorCode?: string | undefined;
  resultSummary?: string | undefined;
  result?: unknown;
  process?: WebProcessOutput | undefined;
  message?: string | undefined;
}): WebFailureCategory {
  const code = (input.errorCode ?? "").toUpperCase();
  const payload = record(input.result);
  const messageFromResult = string(payload?.message) ?? string(payload?.error) ?? "";
  const stream = [input.process?.stderr, input.process?.stdout, input.resultSummary, input.message, messageFromResult]
    .filter(Boolean)
    .join("\n");
  const text = `${code}\n${stream}`.toLowerCase();

  if (code.includes("TIMEOUT") || input.process?.timedOut === true) return "timeout";

  if (
    code === "PATH_OUTSIDE_WORKSPACE"
    || code === "PATH_GRANT_REQUIRED"
    || code === "PROTECTED_WORKSPACE_PATH"
    || code === "MOUNT_NOT_FOUND"
    || code === "MOUNT_READ_ONLY"
    || code === "SYMLINK_NOT_ALLOWED"
    || code === "PATH_NOT_FOUND"
    || code === "NOT_A_DIRECTORY"
  ) {
    return "path_guard";
  }
  if (code === "SENSITIVE_PATH_GRANT_REQUIRED" || text.includes("sensitive path requires")) {
    return "sensitive_path";
  }

  if (
    code.includes("START_FAILED")
    || code.includes("SPAWN")
    || text.includes("could not start")
    || text.includes("spawn ")
    || text.includes("einval")
  ) {
    if (looksLikeIsolation(text)) return "isolation";
    return "spawn";
  }

  if (looksLikeIsolation(text) || looksLikeIsolation(code.toLowerCase())) {
    return "isolation";
  }

  if (
    code.includes("EXIT_NONZERO")
    || code.includes("NONZERO")
    || (typeof input.process?.exitCode === "number" && input.process.exitCode !== 0)
  ) {
    return "exit_nonzero";
  }

  if (
    code.startsWith("INVALID_")
    || code.includes("VALIDATION")
    || code.includes("TOO_LARGE")
    || code.includes("UNSUPPORTED")
  ) {
    return "validation";
  }

  return "other";
}

function looksLikeIsolation(text: string): boolean {
  return (
    text.includes("sandbox")
    || text.includes("srt")
    || text.includes("seatbelt")
    || text.includes("bubblewrap")
    || text.includes("bwrap")
    || text.includes("low integrity")
    || text.includes("low-il")
    || text.includes("win-low-il")
    || text.includes("eperm")
    || text.includes("operation not permitted")
    || text.includes("permission denied")
    || text.includes("access_denied")
    || text.includes("access is denied")
    || text.includes("0x80070005")
    || text.includes("wfp")
    || text.includes("network is unreachable") && text.includes("sandbox")
    || text.includes("blocked by")
    || text.includes("os isolation")
  );
}

const activeSkillBlockPattern = /^skill:active:(workspace|user):([a-z0-9]+(?:-[a-z0-9]+)*):[a-f0-9]{16}$/;

function projectSkillUsages(run: SessionView["runs"][string]): WebSkillUsage[] {
  const usages = new Map<string, WebSkillUsage>();
  for (const stepId of run.stepOrder) {
    const step = run.steps[stepId];
    for (const blockId of step?.context?.includedBlockIds ?? []) {
      const match = activeSkillBlockPattern.exec(blockId);
      if (!match) continue;
      const [, scope, name] = match;
      if (!scope || !name) continue;
      usages.set(`${scope}:${name}`, { name, scope: scope as WebSkillUsage["scope"] });
    }
  }
  return [...usages.values()].sort((left, right) => `${left.scope}:${left.name}`.localeCompare(`${right.scope}:${right.name}`));
}

function projectFormalPlan(
  view: SessionView,
  binding: SessionView["runs"][string]["planBinding"],
): WebFormalPlanProjection | undefined {
  if (!binding) return undefined;
  const revision = view.plans[binding.planId]?.revisions[binding.revision];
  if (!revision || revision.format !== "formal_markdown") return undefined;
  const markdown = revision.markdown?.trim();
  const lines = markdown ? markdown.replace(/\r/g, "").split("\n") : [];
  const previewCollapsed = lines.length > FORMAL_PLAN_PREVIEW_LINES;
  return {
    planId: binding.planId,
    revision: binding.revision,
    title: revision.title,
    path: revision.path,
    markdownPreview: markdown
      ? lines.slice(0, FORMAL_PLAN_PREVIEW_LINES).join("\n")
      : undefined,
    previewCollapsed,
  };
}

function projectWorkPlan(view: SessionView): WebWorkPlanSnapshot | undefined {
  const workPlanId = view.currentWorkPlanId;
  if (!workPlanId) return undefined;
  const plan = view.workPlans[workPlanId];
  if (!plan) return undefined;
  const revision = plan.revisions[plan.latestRevision];
  if (!revision) return undefined;
  return {
    workPlanId,
    revision: revision.revision,
    items: revision.items.map((item) => ({
      workItemId: item.workItemId,
      step: item.step,
      status: item.status,
    })),
    explanation: revision.explanation,
  };
}

function applyDiffFields(action: WebActionProjection): void {
  const extracted = extractDiff(action.result);
  action.diff = extracted.diff;
  action.diffTruncated = extracted.truncated;
  action.gitWorkspaceChange = extracted.gitWorkspaceChange;
}

function enrichStructuredAction(action: WebActionProjection): void {
  if (action.toolName === "update_plan") {
    const fromResult = extractWorkPlanItems(action.result);
    const fromInput = extractWorkPlanItems(action.input);
    action.workPlanItems = fromResult.items ?? fromInput.items;
    action.workPlanExplanation = fromResult.explanation ?? fromInput.explanation;
  }
  if (action.toolName === "ask_question") {
    action.askQuestions = extractAskQuestions(action.input, action.result);
  }
  if (action.toolName === "shell" || action.toolName === "script" || action.toolName === "verify") {
    action.process = extractProcessOutput(action.toolName, action.input, action.result);
  }
}

function extractWorkPlanItems(source: unknown): {
  items: WebWorkPlanItem[] | undefined;
  explanation: string | undefined;
} {
  const value = record(source);
  const plan = Array.isArray(value?.plan) ? value.plan : undefined;
  if (!plan) return { items: undefined, explanation: string(value?.explanation) };
  const items = plan
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      workItemId: string(item.workItemId),
      step: string(item.step) ?? "",
      status: string(item.status) ?? "pending",
    }))
    .filter((item) => item.step.length > 0);
  return {
    items: items.length > 0 ? items : undefined,
    explanation: string(value?.explanation),
  };
}

function extractAskQuestions(input: unknown, result: unknown): WebAskQuestionItem[] | undefined {
  const inputRecord = record(input);
  const questions = Array.isArray(inputRecord?.questions) ? inputRecord.questions : undefined;
  if (!questions || questions.length === 0) return undefined;
  const answers = Array.isArray(record(result)?.answers) ? record(result)!.answers as unknown[] : [];
  const answerById = new Map<string, Record<string, unknown>>();
  for (const answer of answers) {
    const value = record(answer);
    const id = string(value?.questionId);
    if (id && value) answerById.set(id, value);
  }
  return questions
    .map(record)
    .filter((question): question is Record<string, unknown> => Boolean(question))
    .map((question) => {
      const id = string(question.id) ?? "";
      const answer = answerById.get(id);
      const options = Array.isArray(question.options)
        ? question.options
            .map(record)
            .filter((option): option is Record<string, unknown> => Boolean(option))
            .map((option) => ({
              id: string(option.id) ?? "",
              label: string(option.label) ?? string(option.id) ?? "",
            }))
        : [];
      return {
        id,
        header: string(question.header),
        prompt: string(question.prompt) ?? "",
        selection: string(question.selection),
        options,
        selectedOptionIds: Array.isArray(answer?.selectedOptionIds)
          ? answer.selectedOptionIds.map(String)
          : [],
        text: string(answer?.text),
        skipped: answer?.skipped === true,
      };
    });
}

function extractProcessOutput(
  toolName: string,
  input: unknown,
  result: unknown,
): WebProcessOutput | undefined {
  const inputRecord = record(input);
  const payload = processPayload(result);
  const command = toolName === "verify"
    ? `verify ${string(inputRecord?.profile) ?? "?"}`
    : toolName === "script"
      ? `${string(inputRecord?.profile) ?? "?"} script`
      : (() => {
          const args = Array.isArray(inputRecord?.args) ? inputRecord.args.map(String) : [];
          return [string(inputRecord?.command), ...args].filter(Boolean).join(" ");
        })();
  const workspaceChange = record(payload?.workspaceChange);
  return {
    command: command || undefined,
    exitCode: typeof payload?.exitCode === "number" ? payload.exitCode : undefined,
    timedOut: payload?.timedOut === true,
    stdout: string(payload?.stdout),
    stderr: string(payload?.stderr),
    workspaceChanged: workspaceChange?.changed === true,
  };
}

function settleAction(
  action: WebActionProjection,
  sequence: number,
  occurredAt: string,
  actionTiming: Map<string, TimedProjection>,
  stepById: Map<string, WebStepProjection>,
): void {
  action.milestones.terminal = sequence;
  const timing = actionTiming.get(action.actionId) ?? { startAt: undefined, endAt: undefined };
  timing.endAt = occurredAt;
  actionTiming.set(action.actionId, timing);
  action.durationMs = duration(timing.startAt, timing.endAt);
  const step = stepById.get(action.stepId);
  if (step) step.endSequence = Math.max(step.endSequence ?? 0, sequence);
}

function duration(startAt: string | undefined, endAt: string | undefined): number | undefined {
  if (!startAt || !endAt) return undefined;
  const value = Date.parse(endAt) - Date.parse(startAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function summarizeTarget(
  toolName: string,
  input: unknown,
  resources: readonly string[],
  imageLabels: ReadonlyMap<string, string> = new Map(),
): string {
  const value = record(input);
  let target: string | undefined;
  if (toolName === "shell") {
    const args = Array.isArray(value?.args) ? value.args.map(String) : [];
    target = [string(value?.command), ...args].filter(Boolean).join(" ");
  } else if (toolName === "git") {
    const parts = [`git ${string(value?.operation) ?? "status"}`];
    if (value?.ref !== undefined) parts.push(`ref ${String(value.ref)}`);
    if (value?.maxCount !== undefined) parts.push(`maxCount ${String(value.maxCount)}`);
    target = parts.join(" · ");
  } else if (toolName === "move") {
    target = `${string(value?.from) ?? "?"} → ${string(value?.to) ?? "?"}`;
  } else if (toolName === "find") {
    target = [string(value?.pattern) ?? "*", string(value?.path) ?? "."].join(" · ");
  } else if (toolName === "search") {
    target = [string(value?.query), string(value?.path) ?? "."].filter(Boolean).join(" · ");
  } else if (toolName === "verify") {
    target = string(value?.profile);
  } else if (toolName === "update_plan") {
    const plan = Array.isArray(value?.plan) ? value.plan : [];
    target = `${plan.length} to-do${plan.length === 1 ? "" : "s"}`;
  } else if (toolName === "ask_question") {
    const questions = Array.isArray(value?.questions) ? value.questions : [];
    target = `${questions.length} question${questions.length === 1 ? "" : "s"}`;
  } else if (toolName === "read_image") {
    target = summarizeReadImageTarget(input, undefined, imageLabels);
  } else {
    target = string(value?.path) ?? string(value?.url) ?? string(value?.mediaType);
  }
  return shorten(target ?? resources[0] ?? toolName, 180);
}

function summarizeReadImageTarget(
  input: unknown,
  result: unknown,
  imageLabels: ReadonlyMap<string, string>,
): string {
  const value = record(input);
  const output = record(result);
  const artifactRef = string(value?.artifactRef);
  const attachment = artifactRef ? imageLabels.get(artifactRef) : undefined;
  const region = record(output?.region) ?? record(value?.region);
  const regionLabel = region
    && Number.isInteger(region.x)
    && Number.isInteger(region.y)
    && Number.isInteger(region.width)
    && Number.isInteger(region.height)
    ? `crop ${region.x},${region.y} ${region.width}×${region.height}`
    : "full";
  const sizeLabel = Number.isInteger(output?.width) && Number.isInteger(output?.height)
    ? `${output!.width}×${output!.height}`
    : undefined;
  return [attachment ?? (artifactRef ? shortArtifactRef(artifactRef) : "image"), regionLabel, sizeLabel]
    .filter(Boolean)
    .join(" · ");
}

function summarizeReadImageResult(result: unknown): string | undefined {
  const value = record(result);
  if (!value) return undefined;
  const region = record(value.region);
  const regionLabel = region
    && Number.isInteger(region.x)
    && Number.isInteger(region.y)
    && Number.isInteger(region.width)
    && Number.isInteger(region.height)
    ? `crop ${region.x},${region.y} ${region.width}×${region.height}`
    : undefined;
  const sizeLabel = Number.isInteger(value.width) && Number.isInteger(value.height)
    ? `${value.width}×${value.height}`
    : undefined;
  const mediaType = string(value.mediaType);
  return [regionLabel, sizeLabel, mediaType].filter(Boolean).join(" · ") || undefined;
}

function indexSessionImageLabels(view: SessionView): Map<string, string> {
  const labels = new Map<string, string>();
  for (const runId of view.runOrder) {
    const content = view.runs[runId]?.content ?? [];
    let index = 0;
    for (const part of content) {
      if (part.type !== "image") continue;
      index += 1;
      if (!labels.has(part.originalArtifactRef)) {
        labels.set(part.originalArtifactRef, `image #${index} · ${part.source}`);
      }
    }
  }
  return labels;
}

function projectRunImageAttachments(
  content: SessionView["runs"][string]["content"] | undefined,
): WebImageAttachment[] {
  const attachments: WebImageAttachment[] = [];
  let index = 0;
  for (const part of content ?? []) {
    if (part.type !== "image") continue;
    index += 1;
    attachments.push({
      index,
      source: part.source,
      mediaType: part.mediaType,
      width: part.width,
      height: part.height,
      originalArtifactRef: part.originalArtifactRef,
    });
  }
  return attachments;
}

function shortArtifactRef(ref: string): string {
  const digest = ref.replace(/^artifact:\/\//, "");
  if (digest.length <= 16) return ref;
  return `art_${digest.slice(0, 8)}…${digest.slice(-4)}`;
}

function parseModelOutput(parts: unknown[] | undefined): unknown {
  if (!parts) return undefined;
  for (const part of parts) {
    const item = record(part);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      return JSON.parse(item.text) as unknown;
    } catch {
      return item.text;
    }
  }
  return undefined;
}

function summarizeResult(toolName: string, result: unknown): string | undefined {
  if (typeof result === "string") return shorten(result, 220);
  const value = record(result);
  if (!value) return undefined;
  const details = record(value.details);
  if (typeof value.message === "string") {
    const command = typeof details?.command === "string" ? details.command.trim() : "";
    if (toolName === "git" && command) {
      return shorten(`${command} · ${value.message}`, 220);
    }
    return shorten(value.message, 220);
  }
  if (typeof value.stdout === "string" && value.stdout.trim()) return shorten(value.stdout.trim().split(/\r?\n/, 1)[0] ?? "", 220);
  if (typeof details?.stdout === "string" && details.stdout.trim()) {
    return shorten(details.stdout.trim().split(/\r?\n/, 1)[0] ?? "", 220);
  }
  if (typeof value.path === "string" && typeof value.size === "number") return `${value.path} · ${value.size} bytes`;
  if (typeof value.replacements === "number") return `${value.replacements} replacement(s)`;
  if (Array.isArray(value.entries)) return `${value.entries.length} entr${value.entries.length === 1 ? "y" : "ies"}`;
  if (Array.isArray(value.matches)) return `${value.matches.length} match(es)`;
  if (Array.isArray(value.plan)) {
    const completed = value.plan.filter((item) => record(item)?.status === "completed").length;
    return `${completed}/${value.plan.length} done`;
  }
  if (typeof value.exitCode === "number") return `${toolName} exited ${value.exitCode}`;
  return undefined;
}

function projectSkillCall(action: WebActionProjection, result: unknown): WebSkillCall {
  const input = record(action.input);
  const output = record(result);
  const scope = output?.scope === "workspace" || output?.scope === "user" ? output.scope : undefined;
  const name = string(output?.name) ?? string(input?.name);
  const operation = string(input?.operation);
  return {
    name,
    scope,
    operation,
    status: action.status,
    errorCode: action.errorCode,
  };
}

function summarizeSkillCall(call: WebSkillCall | undefined): string | undefined {
  if (!call) return undefined;
  if (call.errorCode) return call.errorCode;
  return [call.operation, call.name, call.scope].filter(Boolean).join(" · ") || "skill";
}

function extractDiff(result: unknown): {
  diff: string | undefined;
  truncated: boolean;
  gitWorkspaceChange: boolean;
} {
  const value = record(result);
  const details = record(value?.details);
  const workspaceChange = record(value?.workspaceChange) ?? record(details?.workspaceChange);
  const fileDiff = string(value?.diff);
  const gitDiff = string(workspaceChange?.diff);
  if (fileDiff) {
    return {
      diff: fileDiff,
      truncated: value?.diffTruncated === true,
      gitWorkspaceChange: false,
    };
  }
  if (gitDiff || workspaceChange?.changed === true) {
    return {
      diff: gitDiff || undefined,
      truncated: workspaceChange?.diffTruncated === true,
      gitWorkspaceChange: true,
    };
  }
  return { diff: undefined, truncated: false, gitWorkspaceChange: false };
}

function processPayload(output: unknown): Record<string, unknown> | undefined {
  const value = record(output);
  if (!value) return undefined;
  const details = record(value.details);
  if (
    details
    && ["exitCode", "timedOut", "stdout", "stderr", "workspaceChange"].some((key) => key in details)
  ) {
    return details;
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
