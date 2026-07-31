import type { GoalContractInput } from "@civaapple/qi-agent/eval";
import type { GoalView, SessionView } from "@civaapple/qi-agent/kernel";

/** Plan-like surface: bare `/goal` opens the hub; any other text is the objective. */
export type ParsedGoalCommand =
  | { readonly mode: "hub" }
  | { readonly mode: "create"; readonly objective: string };

export function parseGoalCommand(argument: string): ParsedGoalCommand {
  const objective = normalizeGoalPrompt(argument);
  if (!objective) return { mode: "hub" };
  return { mode: "create", objective };
}

export function defaultGoalContract(objective: string): GoalContractInput {
  return {
    objective,
    assertions: [{
      assertionId: "objective.met",
      description: objective,
      required: true,
    }],
    evidenceRequirements: [{
      assertionId: "objective.met",
      kinds: ["deterministic", "behavioral", "human"],
      minimum: 1,
    }],
    resources: [{ resource: "attempts", limit: 8, unit: "attempt" }],
    stagnation: { windowSteps: 5, maxEquivalentFailures: 3, onTrip: "park" },
  };
}

export function formatGoalStatus(view: SessionView | undefined): string[] {
  const lines = ["Goal / 追寻", ""];
  if (!view?.currentGoalId) {
    lines.push("No Goal in this Session.", "Create one with /goal <objective>.");
    return lines;
  }
  const goal = view.goals[view.currentGoalId];
  if (!goal) {
    lines.push(`currentGoalId ${view.currentGoalId} is missing from the projection.`);
    return lines;
  }
  lines.push(...formatGoalCard(goal, view));
  const boundRuns = view.runOrder
    .map((runId) => view.runs[runId])
    .filter((run) => run?.goalBinding?.goalId === goal.goalId);
  if (boundRuns.length > 0) {
    lines.push("", "Bound Runs (newest first):");
    for (const run of [...boundRuns].reverse().slice(0, 8)) {
      if (!run) continue;
      lines.push(
        `- ${short(run.runId)} · ${run.status}` +
          (run.terminal?.reason ? ` · ${run.terminal.reason}` : "") +
          (run.trigger !== "user" ? ` · trigger ${run.trigger}` : ""),
      );
    }
  } else {
    lines.push("", "No Goal-bound Runs yet. Choose Continue in /goal.");
  }
  return lines;
}

export function goalHubSummary(view: SessionView | undefined): {
  readonly title: string;
  readonly detail: string;
  readonly state: GoalView["state"] | "none";
} {
  if (!view?.currentGoalId) {
    return {
      title: "No Goal",
      detail: "Use /goal <objective>, or Create below.",
      state: "none",
    };
  }
  const goal = view.goals[view.currentGoalId];
  if (!goal) {
    return {
      title: "Goal missing",
      detail: view.currentGoalId,
      state: "none",
    };
  }
  const budgets = Object.entries(goal.resources)
    .map(([name, value]) => `${name} ${value?.consumed ?? 0}/${value?.limit ?? 0}`)
    .join(" · ");
  return {
    title: `${goal.state} · ${short(goal.goalId)}`,
    detail: budgets ? `${truncate(goal.objective, 80)} · ${budgets}` : truncate(goal.objective, 100),
    state: goal.state,
  };
}

function formatGoalCard(goal: GoalView, view: SessionView): string[] {
  const budgets = Object.entries(goal.resources).map(
    ([name, value]) =>
      `  ${name}: ${value?.consumed ?? 0}/${value?.limit ?? 0} ${value?.unit ?? ""}` +
      (value?.converging ? " · converging" : ""),
  );
  const assertions = Object.values(goal.assertions).map(
    (assertion) => `  ${assertion.assertionId}${assertion.required ? "" : " (optional)"}: ${assertion.description}`,
  );
  const evidenceCount = Object.values(view.evidence).filter((item) => item.goalId === goal.goalId).length;
  const receipt = Object.values(view.controlReceipts)
    .filter((item) => item.goalId === goal.goalId)
    .at(-1);
  return [
    `goalId: ${goal.goalId}`,
    `state: ${goal.state}`,
    `contractVersion: ${goal.contractVersion}`,
    `objective: ${goal.objective}`,
    "assertions:",
    ...assertions,
    ...(budgets.length > 0 ? ["budgets:", ...budgets] : ["budgets: none"]),
    `evidence records: ${evidenceCount}`,
    ...(goal.terminalReason ? [`reason: ${goal.terminalReason}`] : []),
    ...(receipt
      ? [
          `control: start ${receipt.startRight} · stop ${receipt.stopRight} · accept ${receipt.acceptanceRight}` +
            (receipt.phase === "settled" ? ` · settled ${receipt.outcome ?? ""}` : " · granted"),
        ]
      : []),
  ];
}

function normalizeGoalPrompt(argument: string): string {
  const trimmed = argument.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function truncate(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function short(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
