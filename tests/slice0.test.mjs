import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import {
  ConcurrencyError,
  InMemoryEventStore,
  StateTransitionError,
  applySessionEvent,
  replaySession,
} from "@civaapple/qi-kernel";

const fixtureUrl = new URL("../fixtures/golden/authority-denied.json", import.meta.url);
const rawFixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const fixture = rawFixture.map(parseSessionEvent);

function actionTrace(terminalType, terminalData) {
  const stem = structuredClone(fixture.slice(0, 7));
  return [
    ...stem,
    {
      schemaVersion: 1,
      eventId: "evt_outcome_008",
      sessionId: "ses_golden_001",
      sequence: 8,
      occurredAt: "2026-07-22T03:10:00.000Z",
      actor: { kind: "runtime", id: "capability_broker" },
      type: "authority.granted",
      data: {
        runId: "run_golden_001",
        stepId: "stp_golden_001",
        actionId: "act_golden_001",
        leaseId: "lea_golden_001",
      },
    },
    {
      schemaVersion: 1,
      eventId: "evt_outcome_009",
      sessionId: "ses_golden_001",
      sequence: 9,
      occurredAt: "2026-07-22T03:10:01.000Z",
      actor: { kind: "runtime", id: "tool_runner" },
      type: "action.started",
      data: { runId: "run_golden_001", stepId: "stp_golden_001", actionId: "act_golden_001" },
    },
    {
      schemaVersion: 1,
      eventId: `evt_${terminalType.replace("action.", "")}_010`,
      sessionId: "ses_golden_001",
      sequence: 10,
      occurredAt: "2026-07-22T03:10:02.000Z",
      actor: { kind: "runtime", id: "tool_runner" },
      type: terminalType,
      data: {
        runId: "run_golden_001",
        stepId: "stp_golden_001",
        actionId: "act_golden_001",
        ...terminalData,
      },
    },
  ];
}

test("golden trace replays deterministically from trigger to parked", () => {
  const first = replaySession(fixture);
  const second = replaySession(structuredClone(fixture));

  assert.deepEqual(first, second);
  assert.equal(first.version, 9);
  assert.equal(first.currentRunId, "run_golden_001");
  assert.equal(first.runs.run_golden_001.status, "parked");
  assert.deepEqual(first.runs.run_golden_001.terminal, {
    type: "parked",
    reason: "authority-denied",
    detail: "The requested publish action is outside the current control lease",
  });
  assert.equal(first.runs.run_golden_001.actions.act_golden_001.status, "denied");
});

test("event store commits a valid batch atomically and rejects stale writers", () => {
  const store = new InMemoryEventStore();
  const view = store.append("ses_golden_001", 0, fixture);

  assert.equal(view.version, fixture.length);
  assert.equal(store.read("ses_golden_001").events.length, fixture.length);
  assert.throws(
    () => store.append("ses_golden_001", 0, fixture),
    (error) => error instanceof ConcurrencyError && error.expectedVersion === 0 && error.actualVersion === 9,
  );
  assert.equal(store.read("ses_golden_001").events.length, fixture.length);
});

test("event store refuses to alias one Session under another stream key", () => {
  const store = new InMemoryEventStore();

  assert.throws(
    () => store.append("ses_wrong_001", 0, fixture),
    (error) => error instanceof StateTransitionError && error.code === "STREAM_SESSION_MISMATCH",
  );
  assert.equal(store.read("ses_wrong_001").version, 0);
});

test("action cannot start without a persisted authority grant", () => {
  let view;
  for (const event of fixture.slice(0, 6)) view = applySessionEvent(view, event);

  const illegal = {
    ...fixture[6],
    eventId: "evt_illegal_001",
    sequence: 7,
    type: "action.started",
    actor: { kind: "runtime", id: "tool_runner" },
    data: { runId: "run_golden_001", stepId: "stp_golden_001", actionId: "act_golden_001" },
  };

  assert.throws(
    () => applySessionEvent(view, illegal),
    (error) => error instanceof StateTransitionError && error.code === "ACTION_NOT_GRANTED",
  );
});

test("Action events cannot be reassigned to a different Step", () => {
  const awaitingAuthority = replaySession(fixture.slice(0, 7));
  const wrongStepGrant = {
    schemaVersion: 1,
    eventId: "evt_wrong_step_008",
    sessionId: "ses_golden_001",
    sequence: 8,
    occurredAt: "2026-07-22T03:00:07.500Z",
    actor: { kind: "runtime", id: "capability_broker" },
    type: "authority.granted",
    data: {
      runId: "run_golden_001",
      stepId: "stp_wrong_001",
      actionId: "act_golden_001",
      leaseId: "lea_wrong_001",
    },
  };

  assert.throws(
    () => applySessionEvent(awaitingAuthority, wrongStepGrant),
    (error) => error instanceof StateTransitionError && error.code === "ACTION_STEP_MISMATCH",
  );
});

test("Action completion, failure, cancellation and indeterminate effect remain distinct", () => {
  const cases = [
    ["action.completed", { outputRef: "artifact://result" }, "completed"],
    ["action.failed", { errorCode: "TEST_FAILED", evidenceRef: "artifact://test-log" }, "failed"],
    ["action.cancelled", { reason: "User interrupted" }, "cancelled"],
    [
      "action.indeterminate",
      { reason: "Connection lost after send", reconciliationHint: "Check the deployment ledger" },
      "indeterminate",
    ],
  ];

  for (const [eventType, data, expectedStatus] of cases) {
    const view = replaySession(actionTrace(eventType, data));
    assert.equal(view.runs.run_golden_001.actions.act_golden_001.status, expectedStatus);
  }
});

test("a Run cannot fail while an Action still has an unknown settlement", () => {
  const runningAction = replaySession(actionTrace("action.completed", { outputRef: "artifact://unused" }).slice(0, 9));
  const failedRun = {
    schemaVersion: 1,
    eventId: "evt_run_failed_010",
    sessionId: "ses_golden_001",
    sequence: 10,
    occurredAt: "2026-07-22T03:10:03.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "run.failed",
    data: { runId: "run_golden_001", code: "RUNTIME_CRASH" },
  };

  assert.throws(
    () => applySessionEvent(runningAction, failedRun),
    (error) => error instanceof StateTransitionError && error.code === "ACTION_UNSETTLED",
  );
});

test("terminal run outcomes are mutually exclusive", () => {
  const parked = replaySession(fixture);
  const completedAfterPark = {
    schemaVersion: 1,
    eventId: "evt_illegal_002",
    sessionId: "ses_golden_001",
    sequence: 10,
    occurredAt: "2026-07-22T03:00:09.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "run.completed",
    data: { runId: "run_golden_001", completionKind: "response", evaluationIds: [] },
  };

  assert.throws(
    () => applySessionEvent(parked, completedAfterPark),
    (error) => error instanceof StateTransitionError && error.code === "RUN_NOT_ACTIVE",
  );
});

test("verified completion rejects unknown evidence", () => {
  const base = fixture.slice(0, 4).map((event) => structuredClone(event));
  base[3].data.stepId = "stp_verify_001";
  const stepCompleted = {
    schemaVersion: 1,
    eventId: "evt_verify_005",
    sessionId: "ses_golden_001",
    sequence: 5,
    occurredAt: "2026-07-22T03:01:00.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "step.completed",
    data: { runId: "run_golden_001", stepId: "stp_verify_001", finishReason: "response" },
  };
  const evaluation = {
    schemaVersion: 1,
    eventId: "evt_verify_006",
    sessionId: "ses_golden_001",
    sequence: 6,
    occurredAt: "2026-07-22T03:01:01.000Z",
    actor: { kind: "evaluator", id: "judge_v1" },
    type: "evaluation.completed",
    data: {
      runId: "run_golden_001",
      evaluationId: "evl_verify_001",
      assertionId: "design.accepted",
      evaluatorKind: "human",
      evaluatorVersion: "human-review-v1",
      calibration: "not-required",
      outcome: "unknown",
      evidenceRefs: [],
    },
  };
  const completion = {
    schemaVersion: 1,
    eventId: "evt_verify_007",
    sessionId: "ses_golden_001",
    sequence: 7,
    occurredAt: "2026-07-22T03:01:02.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "run.completed",
    data: {
      runId: "run_golden_001",
      completionKind: "verified",
      evaluationIds: ["evl_verify_001"],
    },
  };

  const beforeCompletion = replaySession([...base, stepCompleted, evaluation]);
  assert.throws(
    () => applySessionEvent(beforeCompletion, completion),
    (error) => error instanceof StateTransitionError && error.code === "VERIFICATION_NOT_PASSED",
  );
});

test("untrusted semantic evaluators cannot emit pass or fail", () => {
  const beforeEvaluation = replaySession([
    ...fixture.slice(0, 4),
    {
      schemaVersion: 1,
      eventId: "evt_semantic_005",
      sessionId: "ses_golden_001",
      sequence: 5,
      occurredAt: "2026-07-22T03:02:00.000Z",
      actor: { kind: "runtime", id: "qi" },
      type: "step.completed",
      data: { runId: "run_golden_001", stepId: "stp_golden_001", finishReason: "response" },
    },
  ]);
  const untrustedPass = {
    schemaVersion: 1,
    eventId: "evt_semantic_006",
    sessionId: "ses_golden_001",
    sequence: 6,
    occurredAt: "2026-07-22T03:02:01.000Z",
    actor: { kind: "evaluator", id: "judge_v2" },
    type: "evaluation.completed",
    data: {
      runId: "run_golden_001",
      evaluationId: "evl_semantic_001",
      assertionId: "copy.quality",
      evaluatorKind: "semantic",
      evaluatorVersion: "judge-v2-uncalibrated",
      calibration: "untrusted",
      outcome: "pass",
      evidenceRefs: ["artifact://copy-review"],
    },
  };

  assert.throws(
    () => applySessionEvent(beforeEvaluation, untrustedPass),
    (error) => error instanceof StateTransitionError && error.code === "UNCALIBRATED_SEMANTIC_RESULT",
  );
});
