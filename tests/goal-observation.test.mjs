import assert from "node:assert/strict";
import test from "node:test";
import { GoalEngine } from "@civaapple/qi-agent/eval";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import {
  formatGoalStatus,
  goalObservationProjection,
} from "../apps/cli/dist/goal-command.js";

const control = {
  issuedTo: "user",
  startRight: "user",
  stopRight: "user",
  acceptanceRight: "human",
  delegationRight: false,
  actionLeaseIds: [],
};

test("goalObservationProjection reports ledger-empty and open assertions", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_goal_obs_empty";
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", {}, { kind: "runtime", id: "test" });
  const goals = new GoalEngine(store, sessionId);
  goals.create(
    {
      objective: "Ship it",
      assertions: [{ assertionId: "objective.met", description: "Ship it" }],
      evidenceRequirements: [
        { assertionId: "objective.met", kinds: ["human"], minimum: 1 },
      ],
    },
    control,
  );
  const observation = goalObservationProjection(store.load(sessionId));
  assert.equal(observation.ledger.attention, "empty");
  assert.equal(observation.openAssertionCount, 1);
  assert.match(observation.statusTag, /ledger-empty/);
  const status = formatGoalStatus(store.load(sessionId)).join("\n");
  assert.match(status, /Evidence Ledger/);
  assert.match(status, /not Evidence Ledger/);
});

test("goalObservationProjection marks assertion satisfied after human pass refs", async () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_goal_obs_sat";
  const runId = "run_goal_obs_sat";
  const stepId = "stp_goal_obs_sat";
  const writer = new EventWriter(store, sessionId);
  const runtime = { kind: "runtime", id: "test" };
  writer.append("session.created", {}, runtime);
  const goals = new GoalEngine(store, sessionId);
  const goal = goals.create(
    {
      objective: "Ship it",
      assertions: [{ assertionId: "objective.met", description: "Ship it" }],
      evidenceRequirements: [
        { assertionId: "objective.met", kinds: ["human"], minimum: 1 },
      ],
    },
    control,
  );
  writer.append(
    "run.triggered",
    {
      runId,
      trigger: "goal",
      input: "accept",
      goalBinding: { goalId: goal.goalId, contractVersion: 1 },
    },
    runtime,
  );
  writer.append("run.started", { runId }, runtime);
  writer.append("step.started", { runId, stepId }, runtime);
  const ref = "human://obs";
  goals.recordEvidence({
    goalId: goal.goalId,
    runId,
    assertionId: "objective.met",
    kind: "human",
    artifactRef: ref,
    description: "ok",
    producer: "test",
    reproducible: false,
  });
  const { HumanEvaluator } = await import("@civaapple/qi-agent/eval");
  await goals.evaluate({
    goalId: goal.goalId,
    runId,
    assertionId: "objective.met",
    evaluator: new HumanEvaluator("human-reassess-v1", (input) => ({
      outcome: input.outcome,
      evidenceRefs: [ref],
      reproducible: false,
    })),
    input: { rationale: "ok", outcome: "pass" },
  });
  const observation = goalObservationProjection(store.load(sessionId));
  assert.equal(observation.ledger.assertions[0].status, "satisfied");
  assert.equal(observation.openAssertionCount, 0);
  assert.equal(observation.ledger.attention, "none");
});
