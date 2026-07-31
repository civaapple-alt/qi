import type {
  EventStream,
  SessionSummary,
  SessionView,
} from "@civaapple/qi-agent/kernel";
import type {
  ActionId,
  RunId,
  SessionEvent,
  SessionId,
  StepId,
} from "@civaapple/qi-protocol";
import { defineTool } from "@civaapple/qi-agent/tools";
import { Type } from "@sinclair/typebox";

export type QiSessionInspectionOperation =
  | "sessions"
  | "runs"
  | "run"
  | "problems"
  | "recovery"
  | "last-step"
  | "step"
  | "action";

export interface QiSessionInspectionQuery {
  operation: QiSessionInspectionOperation;
  sessionId?: string;
  runId?: string | "last";
  stepId?: string;
  actionId?: string;
  detail?: "summary" | "detail";
  limit?: number;
}

export interface QiSessionInspectionSource {
  listSessions(): readonly SessionSummary[];
  load(sessionId: SessionId): SessionView | undefined;
  read(sessionId: SessionId, afterVersion?: number): EventStream;
}

export interface QiSessionInspectionOmissions {
  sessions: number;
  runs: number;
  steps: number;
  actions: number;
  listItems: number;
  textCharacters: number;
  resultCharacters: number;
}

export interface QiSessionInspectionResult {
  operation: QiSessionInspectionOperation;
  detail: "summary" | "detail";
  sessionId?: string;
  session?: Record<string, unknown>;
  items: readonly Record<string, unknown>[];
  omissions: QiSessionInspectionOmissions;
  truncated: boolean;
}

export class QiSessionInspectionError extends Error {
  readonly code: "SESSION_NOT_FOUND" | "RUN_NOT_FOUND" | "STEP_NOT_FOUND" | "ACTION_NOT_FOUND" | "ENTITY_OWNERSHIP";

  constructor(code: QiSessionInspectionError["code"], message: string) {
    super(message);
    this.name = "QiSessionInspectionError";
    this.code = code;
  }
}

const defaultLimit = 20;
const maximumLimit = 50;
const summaryTextLimit = 500;
const detailTextLimit = 4_000;
const resultTextLimit = 4_000;
const listLimit = 20;

export function inspectQiSession(
  source: QiSessionInspectionSource,
  query: QiSessionInspectionQuery,
): QiSessionInspectionResult {
  const detail = query.detail ?? "summary";
  const limit = normalizeLimit(query.limit);
  const omissions = emptyOmissions();
  if (query.operation === "sessions") {
    const sessions = source.listSessions();
    const selected = sessions.slice(0, limit);
    omissions.sessions = sessions.length - selected.length;
    return finish(query.operation, detail, undefined, undefined, selected.map(projectSessionSummary), omissions);
  }

  if (!query.sessionId) {
    throw new QiSessionInspectionError("SESSION_NOT_FOUND", `${query.operation} requires sessionId`);
  }
  const sessionId = query.sessionId as SessionId;
  const view = source.load(sessionId);
  if (!view) throw new QiSessionInspectionError("SESSION_NOT_FOUND", `Session ${query.sessionId} was not found`);
  const stream = source.read(sessionId);
  const session = projectSessionHeader(view, sessionId, stream.version);

  if (query.operation === "runs") {
    const runs = view.runOrder.map((runId) => projectRun(view, stream.events, runId, detail, omissions));
    const selected = runs.slice(-limit).reverse();
    omissions.runs = runs.length - selected.length;
    return finish(query.operation, detail, sessionId, session, selected, omissions);
  }

  if (query.operation === "recovery") {
    const item = projectRecovery(view, stream.events, detail, omissions, limit);
    return finish(query.operation, detail, sessionId, session, item ? [item] : [], omissions);
  }

  if (query.runId && query.runId !== "last" && !view.runs[query.runId]) {
    const ownerSessionId = findEntitySession(source, sessionId, "run", query.runId);
    if (ownerSessionId) {
      throw new QiSessionInspectionError(
        "ENTITY_OWNERSHIP",
        `Run ${query.runId} belongs to Session ${ownerSessionId}, not ${sessionId}`,
      );
    }
  }
  const run = resolveRun(view, query.runId);
  if (query.operation === "run") {
    return finish(
      query.operation,
      detail,
      sessionId,
      session,
      [projectRun(view, stream.events, run.runId, detail, omissions)],
      omissions,
    );
  }

  if (query.operation === "last-step") {
    const stepId = run.stepOrder.at(-1);
    if (!stepId) throw new QiSessionInspectionError("STEP_NOT_FOUND", `Run ${run.runId} has no Steps`);
    return finish(
      query.operation,
      detail,
      sessionId,
      session,
      [projectStep(view, stream.events, run.runId, stepId, detail, omissions)],
      omissions,
    );
  }

  if (query.operation === "step") {
    if (!query.stepId) throw new QiSessionInspectionError("STEP_NOT_FOUND", "step requires stepId");
    const owner = findStepOwner(view, query.stepId);
    if (!owner) {
      const ownerSessionId = findEntitySession(source, sessionId, "step", query.stepId);
      if (ownerSessionId) {
        throw new QiSessionInspectionError(
          "ENTITY_OWNERSHIP",
          `Step ${query.stepId} belongs to Session ${ownerSessionId}, not ${sessionId}`,
        );
      }
      throw new QiSessionInspectionError("STEP_NOT_FOUND", `Step ${query.stepId} was not found`);
    }
    if (query.runId && query.runId !== "last" && owner.runId !== query.runId) {
      throw new QiSessionInspectionError(
        "ENTITY_OWNERSHIP",
        `Step ${query.stepId} belongs to Run ${owner.runId}, not ${query.runId}`,
      );
    }
    return finish(
      query.operation,
      detail,
      sessionId,
      session,
      [projectStep(view, stream.events, owner.runId, query.stepId as StepId, detail, omissions)],
      omissions,
    );
  }

  if (query.operation === "action") {
    if (!query.actionId) throw new QiSessionInspectionError("ACTION_NOT_FOUND", "action requires actionId");
    const owner = findActionOwner(view, query.actionId);
    if (!owner) {
      const ownerSessionId = findEntitySession(source, sessionId, "action", query.actionId);
      if (ownerSessionId) {
        throw new QiSessionInspectionError(
          "ENTITY_OWNERSHIP",
          `Action ${query.actionId} belongs to Session ${ownerSessionId}, not ${sessionId}`,
        );
      }
      throw new QiSessionInspectionError("ACTION_NOT_FOUND", `Action ${query.actionId} was not found`);
    }
    if (query.runId && query.runId !== "last" && owner.runId !== query.runId) {
      throw new QiSessionInspectionError(
        "ENTITY_OWNERSHIP",
        `Action ${query.actionId} belongs to Run ${owner.runId}, not ${query.runId}`,
      );
    }
    return finish(
      query.operation,
      detail,
      sessionId,
      session,
      [projectAction(view, stream.events, owner.runId, query.actionId as ActionId, detail, omissions)],
      omissions,
    );
  }

  const problemSteps = run.stepOrder.filter((stepId) => {
    const step = run.steps[stepId];
    const actions = Object.values(run.actions).filter((action) => action.stepId === stepId);
    return step?.finishReason === "error"
      || (step?.rejectedActionCalls?.length ?? 0) > 0
      || actions.some((action) => ["failed", "denied", "cancelled", "indeterminate"].includes(action.status));
  });
  const problemActions = Object.values(run.actions).filter((action) =>
    ["failed", "denied", "cancelled", "indeterminate"].includes(action.status)
  );
  const combined = [
    ...problemSteps.map((stepId) => projectStep(view, stream.events, run.runId, stepId, detail, omissions)),
    ...problemActions.map((action) =>
      projectAction(view, stream.events, run.runId, action.actionId, detail, omissions)
    ),
  ];
  const selected = combined.slice(0, limit);
  omissions.listItems = combined.length - selected.length;
  return finish(query.operation, detail, sessionId, session, selected, omissions);
}

const SessionInspectionInputSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("sessions"),
    Type.Literal("runs"),
    Type.Literal("run"),
    Type.Literal("problems"),
    Type.Literal("recovery"),
    Type.Literal("last-step"),
    Type.Literal("step"),
    Type.Literal("action"),
  ]),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  stepId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  detail: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("detail")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maximumLimit })),
}, { additionalProperties: false });

const recoveryGuidance = [
  "Prefer restored conversation history and already-attached images over this diagnostic projection.",
  "Use recovery only when the prior Run terminal state is unclear (failed/cancelled/parked) or you need imageAttachments.originalArtifactRef.",
  "Do not chain runs→last-step→step→action for ordinary continue.",
  "For a closer crop call read_image with originalArtifactRef; do not search mounts or the Workspace for the same clipboard/path screenshot.",
  "Fields here are diagnostic only — not Evidence of task completion.",
].join(" ");

export function createQiSessionInspectionTool(
  source: QiSessionInspectionSource,
  currentSessionId: SessionId,
) {
  return defineTool({
    description:
      "Bounded Session lifecycle diagnostics for the current Qi project — not a substitute for restored conversation history. " +
      "Prefer already-restored user/assistant messages and attached images when the user says continue. " +
      "Use this tool for failed/cancelled/parked Runs, write-settlement disputes, Formal Plan binding, or when you need imageAttachments.originalArtifactRef. " +
      "When the prior Run terminal state is unclear, call operation=recovery once (status, terminalReason, imageAttachments, lastStep, problem Action summaries) instead of chaining runs→last-step→step→action. " +
      "For a closer crop use read_image with originalArtifactRef; do not search mounts for a clipboard/path screenshot. " +
      "Formal Plan, Work Plan, and reasoning fields are diagnostic only — not Evidence. Cannot accept a database path or read another project.",
    input: SessionInspectionInputSchema,
    output: Type.Unknown(),
    effect: () => "read",
    resources: (input) => input.operation === "sessions"
      ? ["qi:session-catalog"]
      : [`qi:session:${input.sessionId ?? currentSessionId}`],
    async execute(input) {
      return inspectQiSession(source, {
        ...input,
        sessionId: input.sessionId ?? currentSessionId,
        ...(input.runId === undefined ? {} : { runId: input.runId as string | "last" }),
      });
    },
  });
}

function projectSessionSummary(summary: SessionSummary): Record<string, unknown> {
  return {
    kind: "session",
    sessionId: summary.sessionId,
    title: summary.title,
    eventCount: summary.version,
    updatedAt: summary.updatedAt,
  };
}

function projectSessionHeader(
  view: SessionView,
  sessionId: SessionId,
  eventCount: number,
): Record<string, unknown> {
  const header: Record<string, unknown> = {
    sessionId,
    title: view.title ?? sessionId,
    mode: view.mode,
    eventCount,
    runCount: view.runOrder.length,
    activeRunId: [...view.runOrder].reverse().find((candidate) => view.runs[candidate]?.status === "active"),
  };
  if (view.currentWorkPlanId) {
    header.currentWorkPlanId = view.currentWorkPlanId;
    const snapshot = projectWorkPlanSnapshot(view, summaryTextLimit);
    if (snapshot) header.workPlan = snapshot;
  }
  return header;
}

function projectWorkPlanSnapshot(
  view: SessionView,
  stepLimit: number,
): Record<string, unknown> | undefined {
  const workPlanId = view.currentWorkPlanId;
  if (!workPlanId) return undefined;
  const plan = view.workPlans[workPlanId];
  if (!plan) return undefined;
  const revision = plan.revisions[plan.latestRevision];
  if (!revision) return undefined;
  const completedCount = revision.items.filter((item) => item.status === "completed").length;
  const active = revision.items.find((item) => item.status === "in_progress");
  return {
    workPlanId,
    revision: revision.revision,
    itemCount: revision.items.length,
    completedCount,
    ...(active
      ? { inProgressStep: shorten(active.step, stepLimit) }
      : {}),
  };
}

function projectRun(
  view: SessionView,
  events: readonly SessionEvent[],
  runId: RunId,
  detail: "summary" | "detail",
  omissions: QiSessionInspectionOmissions,
): Record<string, unknown> {
  const run = view.runs[runId];
  if (!run) throw new QiSessionInspectionError("RUN_NOT_FOUND", `Run ${runId} was not found`);
  const sequences = sequenceRange(events, { runId });
  const problems = Object.values(run.actions).filter((action) =>
    ["failed", "denied", "cancelled", "indeterminate"].includes(action.status)
  ).length + run.stepOrder.filter((stepId) => run.steps[stepId]?.finishReason === "error").length;
  const formalPlan = projectFormalPlanMeta(view, run.planBinding);
  const imageAttachments = projectImageAttachments(run.content);
  const base: Record<string, unknown> = {
    kind: "run",
    runId,
    sequenceStart: sequences.start,
    sequenceEnd: sequences.end,
    trigger: run.trigger,
    mode: run.mode,
    status: run.status,
    displayTitle: formalPlan
      ? `Accepted Plan · ${formalPlan.title} · rev ${formalPlan.revision}`
      : boundedText(run.input?.trim() || `${run.trigger} Run`, summaryTextLimit, omissions, "textCharacters"),
    stepCount: run.stepOrder.length,
    actionCount: Object.keys(run.actions).length,
    problemCount: problems,
    actionFacts: countActionFacts(run),
    terminalReason: run.terminal?.reason,
    terminalDetail: boundedText(run.terminal?.detail, detailTextLimit, omissions, "textCharacters"),
  };
  if (imageAttachments.length > 0) {
    base.imageCount = imageAttachments.length;
    base.imageAttachments = imageAttachments;
  }
  if (run.planBinding) base.planBinding = { ...run.planBinding };
  if (detail === "detail") {
    const stepIds = run.stepOrder.slice(-listLimit);
    omissions.steps += run.stepOrder.length - stepIds.length;
    base.stepIds = stepIds;
    if (formalPlan) base.formalPlan = formalPlan;
  }
  return base;
}

function projectImageAttachments(
  content: SessionView["runs"][string]["content"],
): Array<Record<string, unknown>> {
  if (!content) return [];
  return content
    .filter((part): part is Extract<NonNullable<typeof content>[number], { type: "image" }> =>
      part.type === "image")
    .map((image) => ({
      source: image.source,
      originalMediaType: image.originalMediaType,
      mediaType: image.mediaType,
      originalWidth: image.originalWidth,
      originalHeight: image.originalHeight,
      width: image.width,
      height: image.height,
      originalArtifactRef: image.originalArtifactRef,
      preparedArtifactRef: image.preparedArtifactRef,
      downsampled: image.downsampled,
    }));
}

function projectRecovery(
  view: SessionView,
  events: readonly SessionEvent[],
  detail: "summary" | "detail",
  omissions: QiSessionInspectionOmissions,
  limit: number,
): Record<string, unknown> | undefined {
  const runId = selectRecoveryRunId(view);
  if (!runId) return undefined;
  const run = view.runs[runId];
  if (!run) return undefined;
  const projected = projectRun(view, events, runId, detail, omissions);
  const imageAttachments = projectImageAttachments(run.content);
  const problemActions = Object.values(run.actions)
    .filter((action) => ["failed", "denied", "cancelled", "indeterminate"].includes(action.status))
    .slice(0, Math.min(limit, listLimit));
  omissions.listItems += Math.max(
    0,
    Object.values(run.actions).filter((action) =>
      ["failed", "denied", "cancelled", "indeterminate"].includes(action.status)
    ).length - problemActions.length,
  );
  const lastStepId = run.stepOrder.at(-1);
  const lastStep = lastStepId === undefined
    ? undefined
    : projectStep(view, events, runId, lastStepId, detail === "detail" ? "detail" : "summary", omissions);
  return {
    kind: "recovery",
    guidance: recoveryGuidance,
    selection: interruptedRunStatuses.has(run.status) ? "interrupted" : "completed-fallback",
    run: {
      runId: projected.runId,
      status: projected.status,
      trigger: projected.trigger,
      mode: projected.mode,
      displayTitle: projected.displayTitle,
      terminalReason: projected.terminalReason,
      terminalDetail: projected.terminalDetail,
      problemCount: projected.problemCount,
      actionFacts: projected.actionFacts,
      ...(imageAttachments.length > 0
        ? { imageCount: imageAttachments.length, imageAttachments }
        : {}),
      ...(projected.planBinding === undefined ? {} : { planBinding: projected.planBinding }),
      ...(detail === "detail" && projected.stepIds !== undefined ? { stepIds: projected.stepIds } : {}),
    },
    ...(lastStep === undefined ? {} : { lastStep }),
    problemCount: problemActions.length,
    problems: problemActions.map((action) => ({
      actionId: action.actionId,
      stepId: action.stepId,
      toolName: action.toolName,
      status: action.status,
      effect: action.effect,
      errorCode: actionErrorCode(action.status, undefined),
      terminalDetail: boundedText(action.terminalDetail, summaryTextLimit, omissions, "textCharacters"),
    })),
  };
}

const interruptedRunStatuses = new Set(["failed", "cancelled", "parked"]);

function selectRecoveryRunId(view: SessionView): RunId | undefined {
  for (let index = view.runOrder.length - 1; index >= 0; index -= 1) {
    const runId = view.runOrder[index];
    if (!runId) continue;
    const run = view.runs[runId];
    if (!run || run.trigger !== "user") continue;
    if (interruptedRunStatuses.has(run.status)) return runId;
  }
  for (let index = view.runOrder.length - 1; index >= 0; index -= 1) {
    const runId = view.runOrder[index];
    if (!runId) continue;
    const run = view.runs[runId];
    if (!run || run.trigger !== "user") continue;
    if (run.status === "completed") return runId;
  }
  return undefined;
}

function projectFormalPlanMeta(
  view: SessionView,
  binding: SessionView["runs"][string]["planBinding"],
): { planId: string; revision: number; title: string; path: string } | undefined {
  if (!binding) return undefined;
  const revision = view.plans[binding.planId]?.revisions[binding.revision];
  if (!revision || revision.format !== "formal_markdown") return undefined;
  return {
    planId: binding.planId,
    revision: binding.revision,
    title: revision.title,
    path: revision.path,
  };
}

function countActionFacts(run: NonNullable<SessionView["runs"][string]>): {
  writeCompleted: number;
  writeFailed: number;
  readCompleted: number;
  workspaceWriteCompleted: number;
  workspaceWriteFailed: number;
  artifactWriteCompleted: number;
  artifactWriteFailed: number;
  otherWriteCompleted: number;
  otherWriteFailed: number;
} {
  let writeCompleted = 0;
  let writeFailed = 0;
  let readCompleted = 0;
  let workspaceWriteCompleted = 0;
  let workspaceWriteFailed = 0;
  let artifactWriteCompleted = 0;
  let artifactWriteFailed = 0;
  let otherWriteCompleted = 0;
  let otherWriteFailed = 0;
  const workspaceTools = new Set(["write", "edit", "move", "remove"]);
  for (const action of Object.values(run.actions)) {
    if (action.effect === "read" && action.status === "completed") {
      readCompleted += 1;
      continue;
    }
    if (action.effect !== "write" || (action.status !== "completed" && action.status !== "failed")) continue;
    const completed = action.status === "completed";
    if (completed) writeCompleted += 1;
    else writeFailed += 1;
    if (workspaceTools.has(action.toolName)) {
      if (completed) workspaceWriteCompleted += 1;
      else workspaceWriteFailed += 1;
    } else if (action.toolName === "artifact") {
      if (completed) artifactWriteCompleted += 1;
      else artifactWriteFailed += 1;
    } else if (completed) {
      otherWriteCompleted += 1;
    } else {
      otherWriteFailed += 1;
    }
  }
  return {
    writeCompleted,
    writeFailed,
    readCompleted,
    workspaceWriteCompleted,
    workspaceWriteFailed,
    artifactWriteCompleted,
    artifactWriteFailed,
    otherWriteCompleted,
    otherWriteFailed,
  };
}

function projectStep(
  view: SessionView,
  events: readonly SessionEvent[],
  runId: RunId,
  stepId: StepId,
  detail: "summary" | "detail",
  omissions: QiSessionInspectionOmissions,
): Record<string, unknown> {
  const run = view.runs[runId];
  const step = run?.steps[stepId];
  if (!run || !step) throw new QiSessionInspectionError("STEP_NOT_FOUND", `Step ${stepId} was not found`);
  const sequences = sequenceRange(events, { runId, stepId });
  const actions = Object.values(run.actions).filter((action) => action.stepId === stepId);
  const rejected = step.rejectedActionCalls ?? [];
  const textLimit = detail === "detail" ? detailTextLimit : summaryTextLimit;
  const base: Record<string, unknown> = {
    kind: "step",
    runId,
    stepId,
    sequenceStart: sequences.start,
    sequenceEnd: sequences.end,
    status: step.status,
    finishReason: step.finishReason,
    actionCount: actions.length,
    rejectedActionCount: rejected.length,
    modelText: boundedText(step.model?.text, textLimit, omissions, "textCharacters"),
    modelReasoning: boundedText(step.model?.reasoning, textLimit, omissions, "textCharacters"),
  };
  if (detail === "detail") {
    const actionIds = actions.slice(0, listLimit).map((action) => action.actionId);
    omissions.actions += actions.length - actionIds.length;
    base.actionIds = actionIds;
    base.rejectedActions = rejected.slice(0, listLimit);
    omissions.listItems += Math.max(0, rejected.length - listLimit);
    base.context = step.context;
  }
  return base;
}

function projectAction(
  view: SessionView,
  events: readonly SessionEvent[],
  runId: RunId,
  actionId: ActionId,
  detail: "summary" | "detail",
  omissions: QiSessionInspectionOmissions,
): Record<string, unknown> {
  const run = view.runs[runId];
  const action = run?.actions[actionId];
  if (!run || !action) throw new QiSessionInspectionError("ACTION_NOT_FOUND", `Action ${actionId} was not found`);
  const matching = events.filter((event) => eventReferences(event, { runId, actionId }));
  const terminal = [...matching].reverse().find((event) =>
    ["action.completed", "action.failed", "action.denied", "action.cancelled", "action.indeterminate", "authority.denied"]
      .includes(event.type)
  );
  const terminalData = eventData(terminal);
  const resources = action.resources.slice(0, listLimit);
  omissions.listItems += action.resources.length - resources.length;
  const parsed = parseModelOutput(terminalData?.modelOutput);
  const proposed = matching.find((event) => event.type === "action.proposed");
  const proposedInput = eventData(proposed)?.input;
  const base: Record<string, unknown> = {
    kind: "action",
    runId,
    stepId: action.stepId,
    actionId,
    sequenceStart: matching.at(0)?.sequence,
    sequenceEnd: matching.at(-1)?.sequence,
    status: action.status,
    toolName: action.toolName,
    effect: action.effect,
    resources,
    errorCode: actionErrorCode(action.status, terminalData),
    terminalDetail: boundedText(action.terminalDetail, summaryTextLimit, omissions, "textCharacters"),
  };
  if (detail === "detail") {
    const result = terminalData?.modelOutput ?? terminalData?.outputRef ?? terminalData?.reason;
    base.result = boundedJson(result, resultTextLimit, omissions);
    if (action.freshnessRebase) base.freshnessRebase = { ...action.freshnessRebase };
    enrichActionDetail(base, action.toolName, proposedInput, parsed, omissions);
  }
  return base;
}

function enrichActionDetail(
  base: Record<string, unknown>,
  toolName: string,
  input: unknown,
  result: unknown,
  omissions: QiSessionInspectionOmissions,
): void {
  if (toolName === "update_plan") {
    const items = extractWorkPlanItems(result) ?? extractWorkPlanItems(input);
    if (items) {
      const selected = items.slice(0, listLimit);
      omissions.listItems += items.length - selected.length;
      base.workPlanItems = selected;
    }
  }
  if (toolName === "shell" || toolName === "script" || toolName === "verify") {
    base.process = extractProcessSummary(toolName, input, result);
  }
  const diffFields = extractDiffFields(result);
  if (diffFields.diffKind) {
    base.diffKind = diffFields.diffKind;
    base.diff = boundedText(diffFields.diff, resultTextLimit, omissions, "resultCharacters");
    if (diffFields.diffTruncated) base.diffTruncated = true;
  }
}

function extractWorkPlanItems(source: unknown): Array<{ workItemId?: string; step: string; status: string }> | undefined {
  const value = record(source);
  const plan = Array.isArray(value?.plan) ? value.plan : undefined;
  if (!plan) return undefined;
  const items = plan
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      ...(typeof item.workItemId === "string" ? { workItemId: item.workItemId } : {}),
      step: typeof item.step === "string" ? item.step : "",
      status: typeof item.status === "string" ? item.status : "pending",
    }))
    .filter((item) => item.step.length > 0);
  return items.length > 0 ? items : undefined;
}

function extractProcessSummary(
  toolName: string,
  input: unknown,
  result: unknown,
): Record<string, unknown> {
  const inputRecord = record(input);
  const payload = processPayload(result);
  const workspaceChange = record(payload?.workspaceChange);
  let command: string | undefined;
  if (toolName === "verify") {
    command = `verify ${typeof inputRecord?.profile === "string" ? inputRecord.profile : "?"}`;
  } else if (toolName === "script") {
    command = `${typeof inputRecord?.profile === "string" ? inputRecord.profile : "?"} script`;
  } else {
    const args = Array.isArray(inputRecord?.args) ? inputRecord.args.map(String) : [];
    command = [typeof inputRecord?.command === "string" ? inputRecord.command : undefined, ...args]
      .filter(Boolean)
      .join(" ") || undefined;
  }
  return {
    ...(command === undefined ? {} : { command }),
    ...(typeof payload?.exitCode === "number" ? { exitCode: payload.exitCode } : {}),
    workspaceChanged: workspaceChange?.changed === true,
  };
}

function extractDiffFields(result: unknown): {
  diffKind: "file" | "git" | undefined;
  diff: string | undefined;
  diffTruncated: boolean;
} {
  const value = record(result);
  const details = record(value?.details);
  const workspaceChange = record(value?.workspaceChange) ?? record(details?.workspaceChange);
  const fileDiff = typeof value?.diff === "string" ? value.diff : undefined;
  const gitDiff = typeof workspaceChange?.diff === "string" ? workspaceChange.diff : undefined;
  if (fileDiff) {
    return {
      diffKind: "file",
      diff: fileDiff,
      diffTruncated: value?.diffTruncated === true,
    };
  }
  if (gitDiff || workspaceChange?.changed === true) {
    return {
      diffKind: "git",
      diff: gitDiff,
      diffTruncated: workspaceChange?.diffTruncated === true,
    };
  }
  return { diffKind: undefined, diff: undefined, diffTruncated: false };
}

function parseModelOutput(parts: unknown): unknown {
  if (!Array.isArray(parts)) return undefined;
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

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function resolveRun(view: SessionView, requested: string | "last" | undefined) {
  const runId = requested === undefined || requested === "last"
    ? view.runOrder.at(-1)
    : requested as RunId;
  if (!runId || !view.runs[runId]) {
    throw new QiSessionInspectionError("RUN_NOT_FOUND", `Run ${requested ?? "last"} was not found`);
  }
  return view.runs[runId]!;
}

function findStepOwner(view: SessionView, stepId: string): { runId: RunId } | undefined {
  for (const runId of view.runOrder) if (view.runs[runId]?.steps[stepId]) return { runId };
  return undefined;
}

function findActionOwner(view: SessionView, actionId: string): { runId: RunId } | undefined {
  for (const runId of view.runOrder) if (view.runs[runId]?.actions[actionId]) return { runId };
  return undefined;
}

function findEntitySession(
  source: QiSessionInspectionSource,
  currentSessionId: SessionId,
  kind: "run" | "step" | "action",
  entityId: string,
): SessionId | undefined {
  for (const summary of source.listSessions().slice(0, maximumLimit)) {
    if (summary.sessionId === currentSessionId) continue;
    const view = source.load(summary.sessionId);
    if (!view) continue;
    if (kind === "run" && view.runs[entityId]) return summary.sessionId;
    if (kind === "step" && findStepOwner(view, entityId)) return summary.sessionId;
    if (kind === "action" && findActionOwner(view, entityId)) return summary.sessionId;
  }
  return undefined;
}

function actionErrorCode(
  status: string,
  terminalData: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof terminalData?.errorCode === "string") return terminalData.errorCode;
  if (status === "denied") return "AUTHORITY_DENIED";
  if (status === "indeterminate") return "INDETERMINATE_EFFECT";
  if (status === "cancelled") return "ACTION_CANCELLED";
  return undefined;
}

function sequenceRange(
  events: readonly SessionEvent[],
  refs: { runId?: string; stepId?: string; actionId?: string },
): { start?: number; end?: number } {
  const matching = events.filter((event) => eventReferences(event, refs));
  const start = matching.at(0)?.sequence;
  const end = matching.at(-1)?.sequence;
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

function eventReferences(
  event: SessionEvent,
  refs: { runId?: string; stepId?: string; actionId?: string },
): boolean {
  const data = eventData(event);
  return (!refs.runId || data?.runId === refs.runId)
    && (!refs.stepId || data?.stepId === refs.stepId)
    && (!refs.actionId || data?.actionId === refs.actionId);
}

function eventData(event: SessionEvent | undefined): Record<string, unknown> | undefined {
  return event?.data as unknown as Record<string, unknown> | undefined;
}

function boundedText(
  value: string | undefined,
  maximum: number,
  omissions: QiSessionInspectionOmissions,
  key: "textCharacters" | "resultCharacters",
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= maximum) return value;
  omissions[key] += value.length - maximum;
  return `${value.slice(0, maximum)}…`;
}

function boundedJson(
  value: unknown,
  maximum: number,
  omissions: QiSessionInspectionOmissions,
): unknown {
  if (value === undefined) return undefined;
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return boundedText(encoded, maximum, omissions, "resultCharacters");
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return defaultLimit;
  if (!Number.isInteger(value) || value < 1 || value > maximumLimit) {
    throw new RangeError(`limit must be an integer from 1 to ${maximumLimit}`);
  }
  return value;
}

function emptyOmissions(): QiSessionInspectionOmissions {
  return {
    sessions: 0,
    runs: 0,
    steps: 0,
    actions: 0,
    listItems: 0,
    textCharacters: 0,
    resultCharacters: 0,
  };
}

function finish(
  operation: QiSessionInspectionOperation,
  detail: "summary" | "detail",
  sessionId: string | undefined,
  session: Record<string, unknown> | undefined,
  items: readonly Record<string, unknown>[],
  omissions: QiSessionInspectionOmissions,
): QiSessionInspectionResult {
  return {
    operation,
    detail,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(session === undefined ? {} : { session }),
    items,
    omissions,
    truncated: Object.values(omissions).some((count) => count > 0),
  };
}
