import type { SessionView } from "@civaapple/qi-agent/kernel";
import type { SessionEvent } from "@civaapple/qi-protocol";

export interface TuiWriter {
  write(text: string): void;
}

export function renderEvent(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "goal.created":
      return `[goal] ${short(event.data.goalId)} active · ${event.data.objective}`;
    case "goal.resource.consumed":
      return `[budget] ${event.data.resource} +${event.data.amount} · ${event.data.reason}`;
    case "goal.convergence.entered":
      return `[budget] ${event.data.resource} ${Math.round(event.data.consumedRatio * 100)}% · convergence`;
    case "goal.stagnation.detected":
      return `[stagnation] ${event.data.equivalentFailures} equivalent failures · ${event.data.decision}`;
    case "evidence.recorded":
      return `[evidence] ${short(event.data.evidenceId)} ${event.data.kind} → ${event.data.artifactRef}`;
    case "evaluation.completed":
      return `[eval] ${event.data.assertionId} ${event.data.outcome}${event.data.reportedOutcome && event.data.reportedOutcome !== event.data.outcome ? ` (reported ${event.data.reportedOutcome})` : ""}`;
    case "goal.state.changed":
      return `[goal] ${short(event.data.goalId)} ${event.data.state} · ${event.data.reason}`;
    case "control.receipt.issued":
      return `[control] ${event.data.phase} · start ${event.data.startRight} · stop ${event.data.stopRight} · accept ${event.data.acceptanceRight}`;
    case "safety.redaction.applied":
      return `[safety] redacted ${event.data.redactions.reduce((total, item) => total + item.count, 0)} secret value(s) at ${event.data.boundary}`;
    case "run.started":
      return `[run] ${short(event.data.runId)} active`;
    case "step.started":
      return `[step] ${short(event.data.stepId)} active`;
    case "context.compacted":
      return `[compact] ${short(event.data.sourceStepId)} ${formatTokens(event.data.originalEstimatedTokens)}→${formatTokens(event.data.compactedEstimatedTokens)} · ${event.data.reason} · ${event.data.artifactRef}`;
    case "context.compiled": {
      const percent = Math.round((event.data.estimatedTokens / event.data.budgetTokens) * 100);
      return `[context] ${formatTokens(event.data.estimatedTokens)}/${formatTokens(event.data.budgetTokens)} ${percent}%${event.data.omittedBlockIds.length ? ` · omitted ${event.data.omittedBlockIds.length}` : ""}`;
    }
    case "model.completed":
      return event.data.text ? `\nagent  ${event.data.text}` : undefined;
    case "model.action.rejected":
      return `[invalid] ${event.data.toolName} ${event.data.errorCode} · ${event.data.reason}`;
    case "action.proposed":
      return `[action] ${short(event.data.actionId)} ${event.data.effect} ${event.data.toolName}${renderInput(event.data.toolName, event.data.input)}${event.data.resources?.length ? ` · ${event.data.resources.join(", ")}` : ""}`;
    case "action.freshness.rebased":
      return `[rebase] ${short(event.data.actionId)} after ${short(event.data.priorActionId)} · ${event.data.resource}`;
    case "action.started":
      return `[running] ${short(event.data.actionId)}`;
    case "authority.denied":
      return `[denied] ${short(event.data.actionId)} ${event.data.reason}`;
    case "action.completed":
      return `[done] ${short(event.data.actionId)}${renderOutput(event.data.modelOutput)}${event.data.outputRef ? ` → ${event.data.outputRef}` : ""}`;
    case "action.failed":
      return `[failed] ${short(event.data.actionId)} ${event.data.errorCode}`;
    case "action.cancelled":
      return `[cancelled] ${short(event.data.actionId)} ${event.data.reason}`;
    case "action.indeterminate":
      return `[indeterminate] ${short(event.data.actionId)} ${event.data.reason}`;
    case "run.completed":
      return `[run] ${short(event.data.runId)} ${event.data.completionKind === "verified" ? "verified" : "responded"}`;
    case "run.parked":
      return `[run] ${short(event.data.runId)} parked · ${event.data.reason}${event.data.detail ? ` · ${event.data.detail}` : ""}`;
    case "run.failed":
      return `[run] ${short(event.data.runId)} failed · ${event.data.code}${event.data.diagnosticRef ? ` · ${renderDiagnostic(event.data.diagnosticRef)}` : ""}`;
    case "run.cancelled":
      return `[run] ${short(event.data.runId)} cancelled · ${event.data.reason}`;
    case "steering.received":
      return `[steer] ${event.data.message}`;
    default:
      return undefined;
  }
}

function renderInput(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const value = input as Record<string, unknown>;
  if (toolName === "shell" && typeof value.command === "string") {
    const args = Array.isArray(value.args) ? value.args.map((argument) => shellArg(argument)).join(" ") : "";
    return ` · $ ${value.command}${args ? ` ${args}` : ""}${typeof value.workdir === "string" ? ` · cwd ${value.workdir}` : ""}`;
  }
  if ((toolName === "write" || toolName === "edit") && typeof value.path === "string") return ` · ${value.path}`;
  if (toolName === "verify" && typeof value.profile === "string") return ` · ${value.profile}`;
  return "";
}

function renderOutput(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  for (const part of parts) {
    if (typeof part !== "object" || part === null || !("text" in part) || typeof part.text !== "string") continue;
    try {
      const value = JSON.parse(part.text) as Record<string, unknown>;
      if ("exitCode" in value) {
        const stdout = typeof value.stdout === "string" ? oneLine(value.stdout, 100) : "";
        const stderr = typeof value.stderr === "string" ? oneLine(value.stderr, 100) : "";
        return ` · exit ${String(value.exitCode)}${value.timedOut ? " · timed out" : ""}${stdout ? ` · ${stdout}` : stderr ? ` · ${stderr}` : ""}`;
      }
      if (typeof value.diff === "string") {
        const additions = value.diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
        const removals = value.diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
        return ` · ${String(value.path ?? "file")} · +${additions} -${removals}`;
      }
    } catch {
      // The durable terminal state is still useful when a tool emits plain text.
    }
  }
  return "";
}

function shellArg(value: unknown): string {
  const text = String(value);
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text;
}

function oneLine(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function formatTokens(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

export function renderStatus(view: SessionView | undefined): string {
  if (!view) return "session empty";
  const run = view.currentRunId ? view.runs[view.currentRunId] : undefined;
  if (!run) return `session ${short(view.sessionId)} · no runs`;
  const actions = Object.values(run.actions);
  const goal = view.currentGoalId ? view.goals[view.currentGoalId] : undefined;
  const budget = goal
    ? Object.entries(goal.resources)
        .map(([name, value]) => `${name} ${value?.consumed ?? 0}/${value?.limit ?? 0}`)
        .join(", ")
    : undefined;
  return [
    `session ${short(view.sessionId)}`,
    ...(goal ? [`goal ${short(goal.goalId)} ${goal.state}${budget ? ` · ${budget}` : ""}`] : []),
    `run ${short(run.runId)} ${runDisplayStatus(run)}`,
    `${run.stepOrder.length} step${run.stepOrder.length === 1 ? "" : "s"}`,
    `${actions.length} action${actions.length === 1 ? "" : "s"}`,
  ].join(" · ");
}

function runDisplayStatus(run: SessionView["runs"][string]): string {
  return run.status === "completed" && run.terminal?.reason === "response" ? "responded" : run.status;
}

function short(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function renderDiagnostic(ref: string): string {
  const prefix = "diagnostic:inline:";
  if (!ref.startsWith(prefix)) return ref;
  try {
    return decodeURIComponent(ref.slice(prefix.length));
  } catch {
    return "diagnostic unavailable";
  }
}
