import type { ContextBlock } from "@civaapple/qi-ai/context";
import type {
  GoalState,
  GoalView,
  RunView,
  SessionView,
} from "@civaapple/qi-agent/kernel";
import type { EvaluationId, GoalId, RunId } from "@civaapple/qi-protocol";

export type GoalContinuationDecision =
  | { readonly kind: "complete"; readonly evaluationIds: readonly EvaluationId[] }
  | { readonly kind: "pause"; readonly reason: string; readonly goalState: Extract<GoalState, "paused"> }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "await-continue"; readonly reason: string }
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "noop"; readonly reason: string };

export interface GoalContinuationInput {
  readonly view: SessionView;
  readonly runId: RunId;
  /** When true, treat a user cancel of the Run as Goal cancel. */
  readonly cancelGoalOnRunCancel?: boolean;
}

/** Narrow port so loop does not depend on `@civaapple/qi-agent/eval`. */
export interface GoalContinuationController {
  complete(goalId: GoalId, evaluationIds: readonly EvaluationId[]): GoalView;
  changeState(goalId: GoalId, state: Exclude<GoalState, "complete">, reason: string): GoalView;
}

/**
 * Pure decision for Session-local 追寻 after a Goal-bound Run settles.
 * Does not append events or grant authority; callers apply the decision via GoalEngine.
 */
export function decideGoalContinuation(input: GoalContinuationInput): GoalContinuationDecision {
  const run = input.view.runs[input.runId];
  if (!run?.goalBinding) {
    return { kind: "noop", reason: "Run is not Goal-bound" };
  }
  const goal = input.view.goals[run.goalBinding.goalId];
  if (!goal) {
    return { kind: "noop", reason: `Goal ${run.goalBinding.goalId} is missing from the projection` };
  }
  if (goal.state === "complete" || goal.state === "cancelled") {
    return { kind: "noop", reason: `Goal is already ${goal.state}` };
  }

  if (run.status === "cancelled") {
    if (input.cancelGoalOnRunCancel) {
      return { kind: "cancel", reason: run.terminal?.reason ?? "Run cancelled" };
    }
    return { kind: "await-continue", reason: "Run cancelled; Goal remains open for explicit continue" };
  }

  const indeterminate = Object.values(run.actions).find((action) => action.status === "indeterminate");
  if (indeterminate || run.terminal?.reason === "indeterminate-effect") {
    if (goal.state === "blocked") {
      return {
        kind: "await-continue",
        reason: indeterminate
          ? `Action ${indeterminate.actionId} has an indeterminate effect; Goal already blocked`
          : (run.terminal?.detail ?? "Indeterminate effect; Goal already blocked"),
      };
    }
    return {
      kind: "block",
      reason: indeterminate
        ? `Action ${indeterminate.actionId} has an indeterminate effect`
        : (run.terminal?.detail ?? "Indeterminate effect"),
    };
  }

  if (run.status === "parked") {
    const reason = run.terminal?.reason ?? "parked";
    if (reason === "budget" || reason === "stagnation") {
      if (goal.state === "paused") {
        return {
          kind: "await-continue",
          reason: run.terminal?.detail ?? `${reason}; Goal already paused`,
        };
      }
      return {
        kind: "pause",
        reason: run.terminal?.detail ?? reason,
        goalState: "paused",
      };
    }
    return {
      kind: "await-continue",
      reason: run.terminal?.detail ?? `Run parked (${reason})`,
    };
  }

  if (run.status === "failed") {
    return {
      kind: "await-continue",
      reason: run.terminal?.reason ?? "Run failed",
    };
  }

  if (run.status === "completed") {
    const passing = collectPassingGoalEvaluations(goal, run);
    if (canCompleteGoal(input.view, goal, passing)) {
      return { kind: "complete", evaluationIds: passing };
    }
    return {
      kind: "await-continue",
      reason: "Run responded without verified Goal evidence",
    };
  }

  return { kind: "noop", reason: `Run status ${run.status} is not terminal` };
}

export function applyGoalContinuationDecision(
  controller: GoalContinuationController,
  goalId: GoalId,
  decision: GoalContinuationDecision,
): GoalView | undefined {
  switch (decision.kind) {
    case "complete":
      return controller.complete(goalId, decision.evaluationIds);
    case "pause":
      return controller.changeState(goalId, "paused", decision.reason);
    case "block":
      return controller.changeState(goalId, "blocked", decision.reason);
    case "cancel":
      return controller.changeState(goalId, "cancelled", decision.reason);
    case "await-continue":
    case "noop":
      return undefined;
  }
}

/** Least-information Goal contract for model context (not completion evidence). */
export function createGoalContextBlock(goal: GoalView): ContextBlock {
  const assertions = Object.values(goal.assertions).map((assertion) =>
    `- assertionId=${assertion.assertionId}; required=${assertion.required}; ${assertion.description}`
  );
  const budgets = Object.entries(goal.resources).map(([name, value]) =>
    `- ${name}: ${value?.consumed ?? 0}/${value?.limit ?? 0} ${value?.unit ?? ""}${value?.converging ? " · converging" : ""}`.trimEnd()
  );
  const evidenceGaps = Object.values(goal.assertions)
    .filter((assertion) => assertion.required)
    .filter((assertion) => {
      const passing = Object.values(goal.evaluations).some(
        (evaluation) => evaluation.assertionId === assertion.assertionId && evaluation.outcome === "pass",
      );
      return !passing;
    })
    .map((assertion) => `- ${assertion.assertionId}`);
  return {
    id: `goal:${goal.goalId}`,
    kind: "control",
    source: "qi:runtime",
    role: "system",
    content: [
      "Runtime-maintained Goal contract for this Session-local 追寻 Run.",
      "It is a completion contract, not proof that work is done. Do not claim Goal complete without matching evidence.",
      `goalId=${goal.goalId}; state=${goal.state}; contractVersion=${goal.contractVersion}`,
      `objective=${goal.objective}`,
      "Assertions:",
      ...assertions,
      ...(budgets.length > 0 ? ["Budgets:", ...budgets] : ["Budgets: none"]),
      ...(evidenceGaps.length > 0
        ? ["Open required assertions:", ...evidenceGaps]
        : ["Open required assertions: none (evaluations still need matching ledger evidence to complete)"]),
      ...(goal.terminalReason ? [`Last Goal reason: ${goal.terminalReason}`] : []),
      ...(goal.boundaries.length > 0 ? [`Boundaries: ${goal.boundaries.join("; ")}`] : []),
    ].join("\n"),
    priority: 990,
    required: true,
    retentionReason: "Goal-bound Runs must see the active completion contract without tool transcripts.",
  };
}

function collectPassingGoalEvaluations(goal: GoalView, run: RunView): EvaluationId[] {
  const ids: EvaluationId[] = [];
  for (const evaluation of Object.values(run.evaluations)) {
    if (evaluation.goalId !== goal.goalId) continue;
    if (evaluation.outcome !== "pass") continue;
    if (evaluation.evaluatorKind === "semantic" && evaluation.calibration !== "trusted") continue;
    ids.push(evaluation.evaluationId);
  }
  for (const evaluation of Object.values(goal.evaluations)) {
    if (ids.includes(evaluation.evaluationId)) continue;
    if (evaluation.outcome !== "pass") continue;
    if (evaluation.evaluatorKind === "semantic" && evaluation.calibration !== "trusted") continue;
    ids.push(evaluation.evaluationId);
  }
  return ids;
}

function canCompleteGoal(
  view: SessionView,
  goal: GoalView,
  evaluationIds: readonly EvaluationId[],
): boolean {
  if (evaluationIds.length === 0) return false;
  const selected = evaluationIds
    .map((id) => goal.evaluations[id])
    .filter((evaluation): evaluation is NonNullable<typeof evaluation> => evaluation !== undefined);
  for (const assertion of Object.values(goal.assertions)) {
    if (!assertion.required) continue;
    const passing = selected.filter(
      (evaluation) => evaluation.assertionId === assertion.assertionId && evaluation.outcome === "pass",
    );
    if (passing.length === 0) return false;
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
      if (count < requirement.minimum) return false;
    }
  }
  return true;
}
