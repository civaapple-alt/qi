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

export interface WebWorkPlanSnapshot {
  workPlanId: string;
  revision: number;
  items: WebWorkPlanItem[];
  explanation: string | undefined;
}

export interface WebRunProjection {
  runId: string;
  trigger: "user" | "goal" | "timer" | "event" | "resume";
  input: string | undefined;
  /** Short label for sidebar / narrative title (Formal Plan aware). */
  displayTitle: string;
  status: RunStatus;
  displayStatus: string;
  terminalReason: string | undefined;
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
    const formalPlan = projectFormalPlan(view, run.planBinding);
    const workPlan = projectWorkPlan(view);
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
      status: run.status,
      displayStatus: run.status === "completed" && run.terminal?.reason === "response"
        ? "responded"
        : run.status === "completed" && run.terminal?.reason === "verified"
          ? "verified"
          : run.status,
      terminalReason: run.terminal?.reason,
      formalPlan,
      workPlan,
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
          applyDiffFields(action);
          enrichStructuredAction(action);
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
          applyDiffFields(action);
          enrichStructuredAction(action);
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
  } else if (toolName === "update_plan") {
    const plan = Array.isArray(value?.plan) ? value.plan : [];
    target = `${plan.length} to-do${plan.length === 1 ? "" : "s"}`;
  } else if (toolName === "ask_question") {
    const questions = Array.isArray(value?.questions) ? value.questions : [];
    target = `${questions.length} question${questions.length === 1 ? "" : "s"}`;
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
  if (Array.isArray(value.plan)) {
    const completed = value.plan.filter((item) => record(item)?.status === "completed").length;
    return `${completed}/${value.plan.length} done`;
  }
  if (typeof value.exitCode === "number") return `${toolName} exited ${value.exitCode}`;
  return undefined;
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
