import type { GoalContractInput } from "@civaapple/qi-agent/eval";
import type { EvidenceKind, GoalView, SessionView } from "@civaapple/qi-agent/kernel";

/** Plan-like surface: bare `/goal` opens the hub; any other text is the objective. */
export type ParsedGoalCommand =
  | { readonly mode: "hub" }
  | { readonly mode: "create"; readonly objective: string };

export type GoalLedgerAssertionStatus = "satisfied" | "partial" | "open";

export type GoalLedgerAttention =
  | "empty"
  | "gap"
  | "orphan"
  | "untrusted"
  | "none";

export type GoalProgressAttention =
  | "complete"
  | "blocked"
  | "paused"
  | "converging"
  | "awaiting"
  | "none";

export interface GoalObservationProjection {
  readonly state: GoalView["state"] | "none";
  readonly goalId?: string;
  readonly objective?: string;
  readonly progressAttention: GoalProgressAttention;
  readonly statusTag: string;
  readonly openAssertionCount: number;
  readonly budgets: string;
  readonly ledger: {
    readonly attention: GoalLedgerAttention;
    readonly evidenceCount: number;
    readonly assertions: readonly {
      readonly assertionId: string;
      readonly required: boolean;
      readonly status: GoalLedgerAssertionStatus;
      readonly kinds: readonly EvidenceKind[];
      readonly minimum: number;
      readonly matchedCount: number;
      readonly description: string;
    }[];
    readonly recentEvidence: readonly {
      readonly evidenceId: string;
      readonly kind: EvidenceKind;
      readonly assertionId?: string;
      readonly description: string;
      readonly artifactRef: string;
      readonly referencedByPass: boolean;
    }[];
    readonly latestHumanEvaluation?: {
      readonly assertionId: string;
      readonly outcome: "pass" | "fail" | "unknown";
      readonly evaluationId: string;
    };
  };
  readonly orthogonalHints: readonly string[];
  readonly recentBoundRuns: readonly {
    readonly runId: string;
    readonly status: string;
    readonly reason?: string;
    readonly trigger: string;
  }[];
}

export function parseGoalCommand(argument: string): ParsedGoalCommand {
  const objective = normalizeGoalPrompt(argument);
  if (!objective) return { mode: "hub" };
  return { mode: "create", objective };
}

export function defaultGoalContract(objective: string, attemptsLimit: number): GoalContractInput {
  if (!Number.isInteger(attemptsLimit) || attemptsLimit < 1) {
    throw new RangeError("attemptsLimit must be a positive integer");
  }
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
    resources: [{ resource: "attempts", limit: attemptsLimit, unit: "attempt" }],
    stagnation: { windowSteps: 5, maxEquivalentFailures: 3, onTrip: "park" },
  };
}

/** Shared observation surface for hub / status / TUI tags (projection, not new truth). */
export function goalObservationProjection(view: SessionView | undefined): GoalObservationProjection {
  if (!view?.currentGoalId) {
    return {
      state: "none",
      progressAttention: "none",
      statusTag: "",
      openAssertionCount: 0,
      budgets: "",
      ledger: {
        attention: "none",
        evidenceCount: 0,
        assertions: [],
        recentEvidence: [],
      },
      orthogonalHints: [],
      recentBoundRuns: [],
    };
  }
  const goal = view.goals[view.currentGoalId];
  if (!goal) {
    return {
      state: "none",
      goalId: view.currentGoalId,
      progressAttention: "none",
      statusTag: "",
      openAssertionCount: 0,
      budgets: "",
      ledger: {
        attention: "none",
        evidenceCount: 0,
        assertions: [],
        recentEvidence: [],
      },
      orthogonalHints: [],
      recentBoundRuns: [],
    };
  }

  const goalEvidence = Object.values(view.evidence).filter((item) => item.goalId === goal.goalId);
  const assertionRows = Object.values(goal.assertions).map((assertion) => {
    const requirements = goal.evidenceRequirements.filter(
      (requirement) => requirement.assertionId === assertion.assertionId,
    );
    const kinds = [...new Set(requirements.flatMap((requirement) => requirement.kinds))];
    const minimum = requirements.reduce((max, requirement) => Math.max(max, requirement.minimum), 0);
    const matchedForKinds = goalEvidence.filter(
      (evidence) =>
        evidence.assertionId === assertion.assertionId
        && (kinds.length === 0 || kinds.includes(evidence.kind)),
    );
    const passing = Object.values(goal.evaluations).filter(
      (evaluation) =>
        evaluation.assertionId === assertion.assertionId
        && evaluation.outcome === "pass"
        && !(evaluation.evaluatorKind === "semantic" && evaluation.calibration !== "trusted"),
    );
    const refsOk = requirements.length === 0 || requirements.every((requirement) => {
      const acceptedRefs = new Set(passing.flatMap((evaluation) => evaluation.evidenceRefs));
      const count = matchedForKinds.filter(
        (evidence) =>
          requirement.kinds.includes(evidence.kind) && acceptedRefs.has(evidence.artifactRef),
      ).length;
      return count >= requirement.minimum;
    });
    let status: GoalLedgerAssertionStatus = "open";
    if (passing.length > 0 && refsOk) status = "satisfied";
    else if (matchedForKinds.length > 0 || passing.length > 0) status = "partial";
    return {
      assertionId: assertion.assertionId,
      required: assertion.required,
      status,
      kinds,
      minimum: minimum || 1,
      matchedCount: matchedForKinds.length,
      description: assertion.description,
    };
  });

  const openAssertionCount = assertionRows.filter(
    (row) => row.required && row.status !== "satisfied",
  ).length;
  const passRefs = new Set(
    Object.values(goal.evaluations)
      .filter((evaluation) => evaluation.outcome === "pass")
      .flatMap((evaluation) => evaluation.evidenceRefs),
  );
  const recentEvidence = [...goalEvidence].reverse().slice(0, 5).map((evidence) => ({
    evidenceId: evidence.evidenceId,
    kind: evidence.kind,
    ...(evidence.assertionId === undefined ? {} : { assertionId: evidence.assertionId }),
    description: evidence.description,
    artifactRef: evidence.artifactRef,
    referencedByPass: passRefs.has(evidence.artifactRef),
  }));
  const orphan = goalEvidence.some((evidence) => !passRefs.has(evidence.artifactRef));
  const untrusted = Object.values(goal.evaluations).some(
    (evaluation) =>
      evaluation.evaluatorKind === "semantic"
      && evaluation.calibration === "untrusted",
  );
  let ledgerAttention: GoalLedgerAttention = "none";
  if (goal.state !== "complete" && goal.state !== "cancelled") {
    if (goalEvidence.length === 0 && Object.values(goal.evaluations).length === 0) {
      ledgerAttention = "empty";
    } else if (openAssertionCount > 0) {
      ledgerAttention = "gap";
    } else if (orphan) {
      ledgerAttention = "orphan";
    } else if (untrusted) {
      ledgerAttention = "untrusted";
    }
  }

  const converging = Object.values(goal.resources).some((value) => value?.converging);
  let progressAttention: GoalProgressAttention = "none";
  if (goal.state === "complete") progressAttention = "complete";
  else if (goal.state === "blocked") progressAttention = "blocked";
  else if (goal.state === "paused") progressAttention = "paused";
  else if (converging) progressAttention = "converging";
  else if (ledgerAttention === "empty" || ledgerAttention === "gap") progressAttention = "awaiting";

  const statusTag = pickStatusTag(progressAttention, ledgerAttention, openAssertionCount);
  const budgets = Object.entries(goal.resources)
    .map(([name, value]) =>
      `${name} ${value?.consumed ?? 0}/${value?.limit ?? 0}${value?.converging ? "*" : ""}`
    )
    .join(" · ");

  const boundRuns = view.runOrder
    .map((runId) => view.runs[runId])
    .filter((run) => run?.goalBinding?.goalId === goal.goalId);
  const recentBoundRuns = [...boundRuns].reverse().slice(0, 8).map((run) => ({
    runId: run!.runId,
    status: run!.status,
    ...(run!.terminal?.reason === undefined ? {} : { reason: run!.terminal.reason }),
    trigger: run!.trigger,
  }));

  const latestHumanEvaluation = Object.values(goal.evaluations)
    .filter((evaluation) => evaluation.evaluatorKind === "human")
    .at(-1);

  const orthogonalHints: string[] = [];
  const workPlanId = view.currentWorkPlanId;
  if (workPlanId) {
    const plan = view.workPlans[workPlanId];
    const revision = plan?.revisions[plan.latestRevision];
    const unfinished = revision?.items.some((item) => item.status !== "completed");
    if (unfinished) {
      orthogonalHints.push("Work Plan navigation present · not Evidence Ledger");
    }
  }
  if (view.pendingReview?.status === "pending") {
    orthogonalHints.push("Formal Plan review pending · /plan · not Goal evidence");
  }
  orthogonalHints.push("Tool diffs and Work Plan todos are not Evidence Ledger records");

  return {
    state: goal.state,
    goalId: goal.goalId,
    objective: goal.objective,
    progressAttention,
    statusTag,
    openAssertionCount,
    budgets,
    ledger: {
      attention: ledgerAttention,
      evidenceCount: goalEvidence.length,
      assertions: assertionRows,
      recentEvidence,
      ...(latestHumanEvaluation
        ? {
            latestHumanEvaluation: {
              assertionId: latestHumanEvaluation.assertionId,
              outcome: latestHumanEvaluation.outcome,
              evaluationId: latestHumanEvaluation.evaluationId,
            },
          }
        : {}),
    },
    orthogonalHints,
    recentBoundRuns,
  };
}

export function formatGoalStatus(view: SessionView | undefined): string[] {
  const observation = goalObservationProjection(view);
  const lines = ["Goal / 追寻", ""];
  if (observation.state === "none") {
    lines.push("No Goal in this Session.", "Create one with /goal <objective>.");
    return lines;
  }
  const goal = view!.goals[view!.currentGoalId!]!;
  lines.push(...formatGoalCard(goal, view!, observation));
  lines.push("", "Evidence Ledger");
  if (observation.ledger.attention !== "none") {
    lines.push(`  attention: ${observation.ledger.attention}`);
  }
  for (const row of observation.ledger.assertions.filter((item) => item.required)) {
    lines.push(
      `  ${row.assertionId}: ${row.status}` +
        ` · ${row.matchedCount}/${row.minimum}` +
        (row.kinds.length > 0 ? ` kinds=${row.kinds.join("|")}` : ""),
    );
  }
  if (observation.ledger.recentEvidence.length > 0) {
    lines.push("  recent:");
    for (const evidence of observation.ledger.recentEvidence) {
      lines.push(
        `  - ${short(evidence.evidenceId)} · ${evidence.kind}` +
          (evidence.assertionId ? ` · ${evidence.assertionId}` : "") +
          (evidence.referencedByPass ? " · referenced" : " · unreferenced") +
          ` · ${truncate(evidence.description, 60)}`,
      );
    }
  } else {
    lines.push("  (empty — diagnostics are not ledger entries)");
  }
  if (observation.ledger.latestHumanEvaluation) {
    const human = observation.ledger.latestHumanEvaluation;
    lines.push(`  latest human eval: ${human.assertionId} · ${human.outcome}`);
  }
  if (observation.recentBoundRuns.length > 0) {
    lines.push("", "Bound Runs (newest first):");
    for (const run of observation.recentBoundRuns) {
      lines.push(
        `- ${short(run.runId)} · ${run.status}` +
          (run.reason ? ` · ${run.reason}` : "") +
          (run.trigger !== "user" ? ` · trigger ${run.trigger}` : ""),
      );
    }
  } else {
    lines.push("", "No Goal-bound Runs yet. Choose Continue in /goal (or Continue with guidance…).");
  }
  lines.push("", "Notes:");
  for (const hint of observation.orthogonalHints) {
    lines.push(`- ${hint}`);
  }
  lines.push("- Continue for next slice · Continue with guidance… when correcting · Accept / Re-evaluate… · /plan");
  return lines;
}

export function goalHubSummary(view: SessionView | undefined): {
  readonly title: string;
  readonly detail: string;
  readonly state: GoalView["state"] | "none";
  readonly statusTag: string;
  readonly observation: GoalObservationProjection;
} {
  const observation = goalObservationProjection(view);
  if (observation.state === "none") {
    return {
      title: "No Goal",
      detail: "Use /goal <objective>, or Create below.",
      state: "none",
      statusTag: "",
      observation,
    };
  }
  const parts = [
    truncate(observation.objective ?? "", 60),
    observation.budgets,
    observation.ledger.attention !== "none" ? `ledger ${observation.ledger.attention}` : undefined,
    observation.openAssertionCount > 0 ? `${observation.openAssertionCount} open assertion(s)` : undefined,
    observation.statusTag ? `→ ${hintForTag(observation.statusTag)}` : undefined,
  ].filter(Boolean);
  return {
    title: `${observation.state} · ${short(observation.goalId ?? "")}`,
    detail: parts.join(" · "),
    state: observation.state,
    statusTag: observation.statusTag,
    observation,
  };
}

function formatGoalCard(
  goal: GoalView,
  view: SessionView,
  observation: GoalObservationProjection,
): string[] {
  const budgets = Object.entries(goal.resources).map(
    ([name, value]) =>
      `  ${name}: ${value?.consumed ?? 0}/${value?.limit ?? 0} ${value?.unit ?? ""}` +
      (value?.converging ? " · converging" : ""),
  );
  const assertions = Object.values(goal.assertions).map(
    (assertion) => `  ${assertion.assertionId}${assertion.required ? "" : " (optional)"}: ${assertion.description}`,
  );
  const receipt = Object.values(view.controlReceipts)
    .filter((item) => item.goalId === goal.goalId)
    .at(-1);
  return [
    `goalId: ${goal.goalId}`,
    `state: ${goal.state}` + (observation.statusTag ? ` · tag ${observation.statusTag}` : ""),
    `contractVersion: ${goal.contractVersion}`,
    `objective: ${goal.objective}`,
    "assertions:",
    ...assertions,
    ...(budgets.length > 0 ? ["budgets:", ...budgets] : ["budgets: none"]),
    `evidence records: ${observation.ledger.evidenceCount}`,
    ...(goal.terminalReason ? [`reason: ${goal.terminalReason}`] : []),
    ...(receipt
      ? [
          `control: start ${receipt.startRight} · stop ${receipt.stopRight} · accept ${receipt.acceptanceRight}` +
            (receipt.phase === "settled" ? ` · settled ${receipt.outcome ?? ""}` : " · granted"),
        ]
      : []),
  ];
}

function pickStatusTag(
  progress: GoalProgressAttention,
  ledger: GoalLedgerAttention,
  openAssertions: number,
): string {
  if (progress === "blocked") return "blocked";
  if (progress === "complete") return "complete";
  if (ledger === "empty") return "ledger-empty";
  if (ledger === "gap") return openAssertions > 0 ? `ledger-gap:${openAssertions}` : "ledger-gap";
  if (progress === "paused") return "paused";
  if (progress === "converging") return "converging";
  if (progress === "awaiting") return "awaiting";
  if (ledger === "orphan") return "ledger-orphan";
  if (ledger === "untrusted") return "ledger-untrusted";
  return "";
}

function hintForTag(tag: string): string {
  if (tag === "blocked") return "inspect Journal then Resume & Continue";
  if (tag === "paused") return "Resume & Continue";
  if (tag === "converging") return "narrow next slice or Accept/Re-evaluate";
  if (tag.startsWith("ledger-")) return "check Evidence Ledger · Continue or Accept/Re-evaluate…";
  if (tag === "awaiting") return "Continue";
  if (tag === "complete") return "done";
  return tag;
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
