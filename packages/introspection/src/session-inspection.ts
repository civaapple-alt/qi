import type {
  EventStream,
  SessionSummary,
  SessionView,
} from "@civaapple/qi-kernel";
import type {
  ActionId,
  RunId,
  SessionEvent,
  SessionId,
  StepId,
} from "@civaapple/qi-protocol";
import { defineTool } from "@civaapple/qi-tools";
import { Type } from "@sinclair/typebox";

export type QiSessionInspectionOperation =
  | "sessions"
  | "runs"
  | "run"
  | "problems"
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
  const session = {
    sessionId,
    title: view.title ?? sessionId,
    mode: view.mode,
    eventCount: stream.version,
    runCount: view.runOrder.length,
    activeRunId: [...view.runOrder].reverse().find((candidate) => view.runs[candidate]?.status === "active"),
  };

  if (query.operation === "runs") {
    const runs = view.runOrder.map((runId) => projectRun(view, stream.events, runId, detail, omissions));
    const selected = runs.slice(-limit).reverse();
    omissions.runs = runs.length - selected.length;
    return finish(query.operation, detail, sessionId, session, selected, omissions);
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

export function createQiSessionInspectionTool(
  source: QiSessionInspectionSource,
  currentSessionId: SessionId,
) {
  return defineTool({
    description:
      "Read a bounded projection of Sessions in the current Qi project. Start with runs, then inspect problems, the last Step, or one explicit Step/Action. This tool cannot accept a database path or read another project.",
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
  const base: Record<string, unknown> = {
    kind: "run",
    runId,
    sequenceStart: sequences.start,
    sequenceEnd: sequences.end,
    trigger: run.trigger,
    mode: run.mode,
    status: run.status,
    stepCount: run.stepOrder.length,
    actionCount: Object.keys(run.actions).length,
    problemCount: problems,
    terminalReason: run.terminal?.reason,
    terminalDetail: boundedText(run.terminal?.detail, detailTextLimit, omissions, "textCharacters"),
  };
  if (detail === "detail") {
    const stepIds = run.stepOrder.slice(-listLimit);
    omissions.steps += run.stepOrder.length - stepIds.length;
    base.stepIds = stepIds;
    base.planBinding = run.planBinding;
  }
  return base;
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
  }
  return base;
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
