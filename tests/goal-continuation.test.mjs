import assert from "node:assert/strict";
import test from "node:test";
import { GoalEngine } from "@civaapple/qi-agent/eval";
import { InMemoryEventStore, StateTransitionError } from "@civaapple/qi-agent/kernel";
import {
  applyGoalContinuationDecision,
  createGoalContextBlock,
  decideGoalContinuation,
  EventWriter,
} from "@civaapple/qi-agent/loop";

const control = {
  issuedTo: "user",
  startRight: "user",
  stopRight: "user",
  acceptanceRight: "human",
  delegationRight: false,
  actionLeaseIds: [],
};

function setup(suffix, options = {}) {
  const store = new InMemoryEventStore();
  const sessionId = `ses_goal_cont_${suffix}`;
  const runId = `run_goal_cont_${suffix}`;
  const stepId = `stp_goal_cont_${suffix}_001`;
  const writer = new EventWriter(store, sessionId);
  const runtime = { kind: "runtime", id: "test" };
  writer.append("session.created", {}, runtime);
  const goals = new GoalEngine(store, sessionId);
  const goal = goals.create(
    {
      objective: "Verify a change",
      assertions: [{ assertionId: "tests.pass", description: "Tests pass" }],
      evidenceRequirements: [
        { assertionId: "tests.pass", kinds: ["deterministic"], minimum: 1 },
      ],
      resources: [{ resource: "attempts", limit: options.attempts ?? 3, unit: "attempt" }],
      stagnation: { windowSteps: 3, maxEquivalentFailures: 2, onTrip: "park" },
    },
    control,
  );
  const runWriter = new EventWriter(store, sessionId);
  runWriter.append(
    "run.triggered",
    {
      runId,
      trigger: "goal",
      input: "continue goal",
      goalBinding: { goalId: goal.goalId, contractVersion: goal.contractVersion },
    },
    runtime,
  );
  runWriter.append("run.started", { runId }, runtime);
  runWriter.append("step.started", { runId, stepId }, runtime);
  runWriter.append("step.completed", { runId, stepId, finishReason: "response" }, runtime);
  return { store, sessionId, runId, stepId, goals, goal, runtime };
}

test("goal-bound Run without evidence awaits continue and does not complete the Goal", () => {
  const { store, runId, goal } = setup("await");
  new EventWriter(store, "ses_goal_cont_await").append(
    "run.completed",
    { runId, completionKind: "response", evaluationIds: [] },
    { kind: "runtime", id: "test" },
  );
  const decision = decideGoalContinuation({ view: store.load("ses_goal_cont_await"), runId });
  assert.equal(decision.kind, "await-continue");
  assert.match(decision.reason, /without verified/i);
  assert.equal(store.load("ses_goal_cont_await").goals[goal.goalId].state, "active");
});

test("budget park decides pause unless GoalEngine already paused the Goal", () => {
  const { store, sessionId, runId, goals, goal } = setup("budget");
  goals.consumeResource(goal.goalId, "attempts", 3, "exhausted", runId);
  const view = store.load(sessionId);
  assert.equal(view.runs[runId].status, "parked");
  assert.equal(view.goals[goal.goalId].state, "paused");
  const decision = decideGoalContinuation({ view, runId });
  assert.equal(decision.kind, "await-continue");
});

test("indeterminate Effect blocks Goal continuation", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_goal_cont_indet";
  const runId = "run_goal_cont_indet";
  const stepId = "stp_goal_cont_indet_001";
  const actionId = "act_goal_cont_indet";
  const writer = new EventWriter(store, sessionId);
  const runtime = { kind: "runtime", id: "test" };
  writer.append("session.created", {}, runtime);
  const goals = new GoalEngine(store, sessionId);
  const goal = goals.create(
    {
      objective: "Verify a change",
      assertions: [{ assertionId: "tests.pass", description: "Tests pass" }],
    },
    control,
  );
  writer.append(
    "run.triggered",
    {
      runId,
      trigger: "goal",
      input: "continue goal",
      goalBinding: { goalId: goal.goalId, contractVersion: goal.contractVersion },
    },
    runtime,
  );
  writer.append("run.started", { runId }, runtime);
  writer.append("step.started", { runId, stepId }, runtime);
  writer.append(
    "action.proposed",
    {
      runId,
      stepId,
      actionId,
      toolName: "shell",
      effect: "execute",
      resources: ["host-process:echo"],
    },
    runtime,
  );
  writer.append("authority.requested", { runId, stepId, actionId }, runtime);
  writer.append(
    "authority.granted",
    { runId, stepId, actionId, leaseId: "lea_goal_cont_indet", policyTrace: [] },
    runtime,
  );
  writer.append("action.started", { runId, stepId, actionId }, runtime);
  writer.append(
    "action.indeterminate",
    {
      runId,
      stepId,
      actionId,
      reason: "lost contact",
      reconciliationHint: "Inspect Effect Journal",
    },
    runtime,
  );
  writer.append("step.completed", { runId, stepId, finishReason: "error" }, runtime);
  writer.append(
    "run.parked",
    { runId, reason: "indeterminate-effect", detail: "lost contact" },
    runtime,
  );
  const view = store.load(sessionId);
  const decision = decideGoalContinuation({ view, runId });
  assert.equal(decision.kind, "block");
  applyGoalContinuationDecision(
    {
      complete: (goalId, evaluationIds) => goals.complete(goalId, evaluationIds, control),
      changeState: (goalId, state, reason) => goals.changeState(goalId, state, reason),
    },
    goal.goalId,
    decision,
  );
  assert.equal(store.load(sessionId).goals[goal.goalId].state, "blocked");
});

test("matching evidence lets GoalContinuation complete the Goal", async () => {
  const { store, sessionId, runId, goals, goal } = setup("complete");
  goals.recordEvidence({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    kind: "deterministic",
    artifactRef: "artifact://goal-cont-report",
    description: "tests",
    producer: "test-runner-v1",
    reproducible: true,
  });
  const { DeterministicEvaluator } = await import("@civaapple/qi-agent/eval");
  const evaluationId = await goals.evaluate({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    evaluator: new DeterministicEvaluator("test-runner-v1", () => ({
      outcome: "pass",
      evidenceRefs: ["artifact://goal-cont-report"],
      reproducible: true,
    })),
    input: undefined,
  });
  new EventWriter(store, sessionId).append(
    "run.completed",
    { runId, completionKind: "response", evaluationIds: [evaluationId] },
    { kind: "runtime", id: "test" },
  );
  const view = store.load(sessionId);
  const decision = decideGoalContinuation({ view, runId });
  assert.equal(decision.kind, "complete");
  applyGoalContinuationDecision(
    {
      complete: (goalId, evaluationIds) => goals.complete(goalId, evaluationIds, control),
      changeState: (goalId, state, reason) => goals.changeState(goalId, state, reason),
    },
    goal.goalId,
    decision,
  );
  assert.equal(store.load(sessionId).goals[goal.goalId].state, "complete");
});

test("createGoalContextBlock is least-information and not completion evidence", () => {
  const { store, sessionId, goal } = setup("ctx");
  const block = createGoalContextBlock(store.load(sessionId).goals[goal.goalId]);
  assert.equal(block.required, true);
  assert.match(block.content, /completion contract/i);
  assert.match(block.content, /Do not claim Goal complete/i);
  assert.doesNotMatch(block.content, /tool-result|action\.proposed/i);
});

test("Kernel rejects goal trigger without binding and terminal Goal binding", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_goal_bind_illegal";
  const writer = new EventWriter(store, sessionId);
  const runtime = { kind: "runtime", id: "test" };
  writer.append("session.created", {}, runtime);
  assert.throws(
    () => writer.append("run.triggered", { runId: "run_missing_bind", trigger: "goal", input: "x" }, runtime),
    (error) => error instanceof StateTransitionError && error.code === "GOAL_BINDING_REQUIRED",
  );
  const goals = new GoalEngine(store, sessionId);
  const goal = goals.create(
    {
      objective: "done",
      assertions: [{ assertionId: "a", description: "a" }],
    },
    control,
  );
  goals.changeState(goal.goalId, "cancelled", "stop");
  assert.throws(
    () =>
      new EventWriter(store, sessionId).append(
        "run.triggered",
        {
          runId: "run_terminal_goal",
          trigger: "goal",
          input: "x",
          goalBinding: { goalId: goal.goalId, contractVersion: 1 },
        },
        runtime,
      ),
    (error) => error instanceof StateTransitionError && error.code === "GOAL_TERMINAL",
  );
});

test("sessionArchiveBlockers include unfinished Goals", async () => {
  const { sessionArchiveBlockers } = await import("@civaapple/qi-agent/kernel");
  const { store, sessionId, runId, goal } = setup("archive");
  new EventWriter(store, sessionId).append(
    "run.completed",
    { runId, completionKind: "response", evaluationIds: [] },
    { kind: "runtime", id: "test" },
  );
  const blockers = sessionArchiveBlockers(store.load(sessionId));
  assert.ok(blockers.some((item) => item.includes(goal.goalId) && item.includes("active")));
});
