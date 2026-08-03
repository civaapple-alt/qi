import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicEvaluator,
  EvaluatorCalibrationRegistry,
  GoalEngine,
  SemanticEvaluator,
  evaluatorIdentity,
  failureFingerprint,
} from "@civaapple/qi-agent/eval";
import { InMemoryEventStore, StateTransitionError } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";

const control = {
  issuedTo: "user",
  startRight: "user",
  stopRight: "contract",
  acceptanceRight: "evaluator",
  delegationRight: false,
  actionLeaseIds: ["lea_goal_test"],
};

function setup(suffix) {
  const store = new InMemoryEventStore();
  const sessionId = `ses_goal_${suffix}`;
  const runId = `run_goal_${suffix}`;
  const stepId = `stp_goal_${suffix}_001`;
  const writer = new EventWriter(store, sessionId);
  const runtime = { kind: "runtime", id: "test" };
  writer.append("session.created", {}, runtime);
  const goals = new GoalEngine(store, sessionId);
  const goal = goals.create(
    {
      objective: "Ship a verified change",
      assertions: [{ assertionId: "tests.pass", description: "Tests pass" }],
      evidenceRequirements: [
        { assertionId: "tests.pass", kinds: ["deterministic"], minimum: 1 },
      ],
      boundaries: ["no deploy"],
      resources: [{ resource: "attempts", limit: 2, unit: "attempt" }],
    },
    control,
  );
  const runWriter = new EventWriter(store, sessionId);
  runWriter.append("run.triggered", { runId, trigger: "user", input: "work" }, runtime);
  runWriter.append("run.started", { runId }, runtime);
  runWriter.append("step.started", { runId, stepId }, runtime);
  runWriter.append("step.completed", { runId, stepId, finishReason: "response" }, runtime);
  return { store, sessionId, runId, stepId, goals, goal };
}

test("Goal completion requires passing assertions backed by matching ledger evidence", async () => {
  const { store, runId, goals, goal } = setup("complete");
  assert.throws(
    () => goals.complete(goal.goalId, [], control),
    (error) => error instanceof StateTransitionError && error.code === "GOAL_ASSERTION_NOT_PASSED",
  );

  goals.recordEvidence({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    kind: "deterministic",
    artifactRef: "artifact://test-report",
    description: "npm test output",
    producer: "test-runner-v1",
    reproducible: true,
  });
  const evaluator = new DeterministicEvaluator("test-runner-v1", () => ({
    outcome: "pass",
    evidenceRefs: ["artifact://test-report"],
    reproducible: true,
  }));
  const evaluationId = await goals.evaluate({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    evaluator,
    input: undefined,
  });
  const completed = goals.complete(goal.goalId, [evaluationId], control);
  assert.equal(completed.state, "complete");

  const view = store.load("ses_goal_complete");
  const receipts = Object.values(view.controlReceipts);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].phase, "granted");
  assert.equal(receipts[1].phase, "settled");
  assert.equal(receipts[1].outcome, "complete");
  assert.deepEqual(receipts[1].resources, [
    { resource: "attempts", limit: 2, consumed: 0, unit: "attempt" },
  ]);
});

test("uncalibrated semantic results preserve the report but become unknown in trusted projection", async () => {
  const { store, runId, goals, goal } = setup("uncalibrated");
  goals.recordEvidence({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    kind: "deterministic",
    artifactRef: "artifact://semantic-input",
    description: "Evidence reviewed by judge",
    producer: "fixture",
    reproducible: true,
  });
  const identity = {
    kind: "semantic",
    model: "judge-model",
    prompt: "prompt hash",
    rubric: "rubric hash",
    toolchain: "toolchain hash",
    version: "v1",
  };
  const semantic = new SemanticEvaluator(identity, async () => ({
    outcome: "pass",
    evidenceRefs: ["artifact://semantic-input"],
    reproducible: true,
    confidence: 0.9,
  }));
  const evaluationId = await goals.evaluate({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    evaluator: semantic,
    input: undefined,
    calibration: new EvaluatorCalibrationRegistry(),
  });
  const evaluation = store.load("ses_goal_uncalibrated").runs[runId].evaluations[evaluationId];
  assert.equal(evaluation.outcome, "unknown");
  assert.equal(evaluation.reportedOutcome, "pass");
  assert.equal(evaluation.calibration, "untrusted");
  assert.equal(evaluation.evaluatorVersion, evaluatorIdentity(identity));
  assert.throws(
    () => goals.complete(goal.goalId, [evaluationId], control),
    (error) => error instanceof StateTransitionError && error.code === "GOAL_ASSERTION_NOT_PASSED",
  );
});

test("a calibrated semantic evaluator can contribute trusted completion", async () => {
  const { runId, goals, goal } = setup("calibrated");
  goals.recordEvidence({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    kind: "deterministic",
    artifactRef: "artifact://trusted-input",
    description: "Trusted replay input",
    producer: "fixture",
    reproducible: true,
  });
  const identity = {
    kind: "semantic",
    model: "judge-model",
    prompt: "prompt hash",
    rubric: "rubric hash",
    toolchain: "toolchain hash",
    version: "v2",
  };
  const calibration = new EvaluatorCalibrationRegistry();
  calibration.record(identity, {
    truePass: 20,
    trueReject: 20,
    falsePass: 0,
    falseReject: 1,
    measuredAt: "2026-07-01T00:00:00.000Z",
    validUntil: "2099-08-01T00:00:00.000Z",
  });
  const semantic = new SemanticEvaluator(identity, async () => ({
    outcome: "pass",
    evidenceRefs: ["artifact://trusted-input"],
    reproducible: true,
  }));
  const evaluationId = await goals.evaluate({
    goalId: goal.goalId,
    runId,
    assertionId: "tests.pass",
    evaluator: semantic,
    input: undefined,
    calibration,
  });
  assert.equal(goals.complete(goal.goalId, [evaluationId], control).state, "complete");
});

test("resource exhaustion enters convergence then parks the Run and pauses the Goal", () => {
  const { store, runId, goals, goal } = setup("budget");
  const converging = goals.consumeResource(goal.goalId, "attempts", 1.5, "first attempts", runId);
  assert.equal(converging.converging, true);
  assert.equal(converging.exhausted, false);
  const exhausted = goals.consumeResource(goal.goalId, "attempts", 0.5, "last attempt", runId);
  assert.equal(exhausted.exhausted, true);
  const view = store.load("ses_goal_budget");
  assert.equal(view.goals[goal.goalId].state, "paused");
  assert.equal(view.runs[runId].status, "parked");
  assert.equal(view.runs[runId].terminal.reason, "budget");
  assert.throws(() => goals.consumeResource(goal.goalId, "attempts", 1, "overrun", runId), /is paused/i);
});

test("equivalent failure fingerprints trip stagnation without timestamp, ID, stack-line or resource-order noise", () => {
  const { store, runId, goals, goal } = setup("stagnation");
  const runtime = { kind: "runtime", id: "test" };
  const fingerprints = [];
  for (let index = 1; index <= 3; index += 1) {
    const stepId = `stp_stagnation_00${index}`;
    const writer = new EventWriter(store, "ses_goal_stagnation");
    writer.append("step.started", { runId, stepId }, runtime);
    writer.append("step.completed", { runId, stepId, finishReason: "error" }, runtime);
    const result = goals.recordFailure({
      goalId: goal.goalId,
      runId,
      stepId,
      assertionId: "tests.pass",
      evaluatorIdentity: "test-runner-v1",
      errorCode: `FAIL at 2026-07-22T00:00:0${index}.000Z run_abc_${index}`,
      stackFrames: [`at check (src/test.ts:${10 + index}:2)`],
      targetResources: index % 2 ? ["file:b", "file:a"] : ["file:a", "file:b"],
    });
    fingerprints.push(result.fingerprint);
    assert.equal(result.tripped, index === 3);
  }
  assert.equal(new Set(fingerprints).size, 1);
  const view = store.load("ses_goal_stagnation");
  assert.equal(view.goals[goal.goalId].state, "paused");
  assert.equal(view.runs[runId].terminal.reason, "stagnation");
});

test("failure fingerprint changes when the assertion, evaluator, error or resource changes", () => {
  const base = {
    assertionId: "a",
    evaluatorIdentity: "evaluator-v1",
    errorCode: "FAIL",
    targetResources: ["file:a"],
  };
  const first = failureFingerprint(base);
  assert.notEqual(first, failureFingerprint({ ...base, assertionId: "b" }));
  assert.notEqual(first, failureFingerprint({ ...base, evaluatorIdentity: "evaluator-v2" }));
  assert.notEqual(first, failureFingerprint({ ...base, errorCode: "OTHER" }));
  assert.notEqual(first, failureFingerprint({ ...base, targetResources: ["file:b"] }));
});
