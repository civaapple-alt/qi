import type { ActionStatus, RunStatus, SessionView } from "@civaapple/qi-kernel";
import type { SessionEvent } from "@civaapple/qi-protocol";

export interface WebActionMilestones {
  proposed: number | undefined;
  authorityRequested: number | undefined;
  authorityGranted: number | undefined;
  started: number | undefined;
  terminal: number | undefined;
}

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
  result: unknown;
  resultSummary: string | undefined;
  diff: string | undefined;
  diffTruncated: boolean;
  durationMs: number | undefined;
  recovered: boolean;
  milestones: WebActionMilestones;
}

export interface WebStepProjection {
  stepId: string;
  index: number;
  status: "running" | "model-complete" | "settled";
  finishReason: "action-requested" | "response" | "error" | undefined;
  modelText: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  context: { estimatedTokens: number; budgetTokens: number; omitted: number } | undefined;
  rejectedCalls: Array<{ toolName: string; errorCode: string; reason: string }>;
  actions: WebActionProjection[];
  startSequence: number | undefined;
  endSequence: number | undefined;
}

export interface WebRunProjection {
  runId: string;
  trigger: "user" | "timer" | "event" | "resume";
  input: string | undefined;
  status: RunStatus;
  displayStatus: string;
  terminalReason: string | undefined;
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
    effects: string[];
    tools: string[];
  };
}

export interface WebSessionProjection {
  sessionId: string;
  title: string | undefined;
  presence: SessionView["presence"];
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
  const runs: WebRunProjection[] = view.runOrder.map((runId): WebRunProjection => {
    const run = view.runs[runId];
    if (!run) throw new Error(`Session projection references missing Run ${runId}`);
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
          result: undefined,
          resultSummary: undefined,
          diff: undefined,
          diffTruncated: false,
          durationMs: undefined,
          recovered: action.status === "failed" && run.status === "completed",
          milestones: {
            proposed: undefined,
            authorityRequested: undefined,
            authorityGranted: undefined,
            started: undefined,
            terminal: undefined,
          },
        }));
      return {
        stepId: step.stepId,
        index: index + 1,
        status: step.status === "running" ? "running" : actions.every((action) => terminalActionStatuses.has(action.status))
          ? "settled"
          : "model-complete",
        finishReason: step.finishReason,
        modelText: step.model?.text,
        provider: step.model?.provider,
        model: step.model?.model,
        context: step.context
          ? {
              estimatedTokens: step.context.estimatedTokens,
              budgetTokens: step.context.budgetTokens,
              omitted: step.context.omittedBlockIds.length,
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
      status: run.status,
      displayStatus: run.status === "completed" && run.terminal?.reason === "response"
        ? "responded"
        : run.status === "completed" && run.terminal?.reason === "verified"
          ? "verified"
          : run.status,
      terminalReason: run.terminal?.reason,
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
        effects: [],
        tools: [],
      },
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
          action.target = summarizeTarget(action.toolName, event.data.input, action.resources);
          action.milestones.proposed = event.sequence;
          actionTiming.set(action.actionId, { startAt: event.occurredAt, endAt: undefined });
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
        if (action) action.milestones.authorityGranted = event.sequence;
        break;
      }
      case "authority.denied": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.terminalDetail = event.data.reason;
          settleAction(action, event.sequence, event.occurredAt, actionTiming, stepById);
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
          action.result = parseModelOutput(event.data.modelOutput);
          action.resultSummary = summarizeResult(action.toolName, action.result);
          const extracted = extractDiff(action.result);
          action.diff = extracted.diff;
          action.diffTruncated = extracted.truncated;
          settleAction(action, event.sequence, event.occurredAt, actionTiming, stepById);
        }
        break;
      }
      case "action.failed": {
        const action = actionById.get(event.data.actionId);
        if (action) {
          action.errorCode = event.data.errorCode;
          action.result = parseModelOutput(event.data.modelOutput);
          action.resultSummary = summarizeResult(action.toolName, action.result);
          const extracted = extractDiff(action.result);
          action.diff = extracted.diff;
          action.diffTruncated = extracted.truncated;
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
    run.summary = {
      stepCount: run.steps.length,
      actionCount: actions.length,
      completedActions: actions.filter((action) => action.status === "completed").length,
      failedActions: actions.filter((action) => action.status === "failed").length,
      recoveredFailures: actions.filter((action) => action.recovered).length,
      deniedActions: actions.filter((action) => action.status === "denied").length,
      effects: [...new Set(actions.map((action) => action.effect))],
      tools: [...new Set(actions.map((action) => action.toolName))],
    };
    const timing = runTiming.get(run.runId);
    run.startedAt = timing?.startAt;
    run.endedAt = timing?.endAt;
    run.durationMs = duration(timing?.startAt, timing?.endAt);
  }

  return {
    sessionId: view.sessionId,
    title: view.title,
    presence: view.presence,
    runs,
    currentRunId: view.currentRunId,
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

function summarizeTarget(toolName: string, input: unknown, resources: readonly string[]): string {
  const value = record(input);
  let target: string | undefined;
  if (toolName === "shell") {
    const args = Array.isArray(value?.args) ? value.args.map(String) : [];
    target = [string(value?.command), ...args].filter(Boolean).join(" ");
  } else if (toolName === "git") {
    target = string(value?.operation);
  } else if (toolName === "move") {
    target = `${string(value?.from) ?? "?"} → ${string(value?.to) ?? "?"}`;
  } else if (toolName === "find") {
    target = [string(value?.pattern) ?? "*", string(value?.path) ?? "."].join(" · ");
  } else if (toolName === "search") {
    target = [string(value?.query), string(value?.path) ?? "."].filter(Boolean).join(" · ");
  } else if (toolName === "verify") {
    target = string(value?.profile);
  } else {
    target = string(value?.path) ?? string(value?.url) ?? string(value?.mediaType);
  }
  return shorten(target ?? resources[0] ?? toolName, 180);
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
  if (typeof value.message === "string") return shorten(value.message, 220);
  if (typeof value.stdout === "string" && value.stdout.trim()) return shorten(value.stdout.trim().split(/\r?\n/, 1)[0] ?? "", 220);
  if (typeof details?.stdout === "string" && details.stdout.trim()) {
    return shorten(details.stdout.trim().split(/\r?\n/, 1)[0] ?? "", 220);
  }
  if (typeof value.path === "string" && typeof value.size === "number") return `${value.path} · ${value.size} bytes`;
  if (typeof value.replacements === "number") return `${value.replacements} replacement(s)`;
  if (Array.isArray(value.entries)) return `${value.entries.length} entr${value.entries.length === 1 ? "y" : "ies"}`;
  if (Array.isArray(value.matches)) return `${value.matches.length} match(es)`;
  if (typeof value.exitCode === "number") return `${toolName} exited ${value.exitCode}`;
  return undefined;
}

function extractDiff(result: unknown): { diff: string | undefined; truncated: boolean } {
  const value = record(result);
  const details = record(value?.details);
  const workspaceChange = record(value?.workspaceChange) ?? record(details?.workspaceChange);
  const diff = string(value?.diff) ?? string(workspaceChange?.diff);
  const truncated = value?.diffTruncated === true || workspaceChange?.diffTruncated === true;
  return { diff: diff || undefined, truncated };
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
