import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCapabilityBroker, modeAllowsIntent } from "@civaapple/qi-capability";
import { InMemoryEventStore, StateTransitionError, applySessionEvent } from "@civaapple/qi-kernel";
import { EventWriter, HumanControlService, SessionSupervisor, toolsForMode } from "@civaapple/qi-loop";
import { createId } from "@civaapple/qi-protocol";

test("legacy Sessions without mode replay as agent", () => {
  const sessionId = "ses_legacy_mode_001";
  let view = applySessionEvent(undefined, {
    schemaVersion: 1,
    eventId: "evt_legacy_001",
    sessionId,
    sequence: 1,
    occurredAt: "2026-07-23T00:00:00.000Z",
    actor: { kind: "runtime", id: "test" },
    type: "session.created",
    data: {},
  });
  assert.equal(view.mode, "agent");
  view = applySessionEvent(view, {
    schemaVersion: 1,
    eventId: "evt_legacy_002",
    sessionId,
    sequence: 2,
    occurredAt: "2026-07-23T00:00:01.000Z",
    actor: { kind: "user", id: "user" },
    type: "run.triggered",
    data: { runId: "run_legacy_001", trigger: "user", input: "hi" },
  });
  assert.equal(view.runs.run_legacy_001.mode, "agent");
});

test("Ask mode denies write Actions at the Kernel boundary", () => {
  const sessionId = "ses_ask_mode_001";
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { mode: "ask" }, { kind: "runtime", id: "test" });
  writer.append("run.triggered", { runId: "run_ask_001", trigger: "user", mode: "ask", input: "q" }, { kind: "user", id: "u" });
  writer.append("run.started", { runId: "run_ask_001" }, { kind: "runtime", id: "test" });
  writer.append("step.started", { runId: "run_ask_001", stepId: "stp_ask_001" }, { kind: "runtime", id: "test" });
  assert.throws(
    () => writer.append(
      "action.proposed",
      {
        runId: "run_ask_001",
        stepId: "stp_ask_001",
        actionId: "act_ask_001",
        toolName: "write",
        toolIdentity: "write@1",
        input: { path: "x.txt", content: "nope", expectedSha256: null },
        effect: "write",
        resources: ["file:x.txt"],
      },
      { kind: "agent", id: "agent" },
    ),
    (error) => error instanceof StateTransitionError && error.code === "MODE_EFFECT_DENIED",
  );
});

test("Plan accept atomically switches to Agent and triggers exactly one Run", () => {
  const sessionId = createId("ses");
  const store = new InMemoryEventStore();
  const control = new HumanControlService({ eventStore: store });
  control.ensureSession(sessionId, "mode test", "plan");
  control.recordPlanRevision(sessionId, {
    planId: createId("pln"),
    title: "Demo",
    overview: "Two items",
    artifactRef: "artifact://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: "/tmp/plan.md",
    items: [
      {
        planItemId: "pit_one00001",
        title: "One",
        description: "First",
        dependsOn: [],
      },
      {
        planItemId: "pit_two00001",
        title: "Two",
        description: "Second",
        dependsOn: [],
      },
    ],
  });
  const accepted = control.acceptPlanAndStartFirstRun(sessionId);
  assert.equal(accepted.view.mode, "agent");
  assert.equal(accepted.view.pendingReview, undefined);
  const triggered = Object.values(accepted.view.runs).filter((run) => run.status === "triggered");
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].planBinding.planItemId, "pit_one00001");

  // Complete the first Run, ask next, continue once — still only one new Run.
  const writer = new EventWriter(store, sessionId);
  writer.append("run.started", { runId: accepted.runId }, { kind: "runtime", id: "test" });
  writer.append(
    "step.started",
    { runId: accepted.runId, stepId: "stp_mode_001" },
    { kind: "runtime", id: "test" },
  );
  writer.append(
    "step.completed",
    { runId: accepted.runId, stepId: "stp_mode_001", finishReason: "response" },
    { kind: "runtime", id: "test" },
  );
  writer.append(
    "run.completed",
    { runId: accepted.runId, completionKind: "response", evaluationIds: [] },
    { kind: "runtime", id: "test" },
  );
  control.askNextRunQuestion(sessionId, accepted.runId);
  const next = control.answerNextRunQuestion(sessionId, "continue");
  assert.ok(next.runId);
  assert.equal(
    Object.values(next.view.runs).filter((run) => run.status === "triggered").length,
    1,
  );
  assert.equal(next.view.runs[next.runId].planBinding.planItemId, "pit_two00001");
});

test("next-run stop can re-ask and continue later; return_to_plan switches to Plan", () => {
  const sessionId = createId("ses");
  const store = new InMemoryEventStore();
  const control = new HumanControlService({ eventStore: store });
  control.ensureSession(sessionId, "stop resume", "plan");
  const planId = createId("pln");
  control.recordPlanRevision(sessionId, {
    planId,
    title: "Demo",
    overview: "Two items",
    artifactRef: "artifact://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: "/tmp/plan.md",
    items: [
      { planItemId: "pit_one00001", title: "One", description: "First", dependsOn: [] },
      { planItemId: "pit_two00001", title: "Two", description: "Second", dependsOn: [] },
    ],
  });
  const accepted = control.acceptPlanAndStartFirstRun(sessionId);
  const writer = new EventWriter(store, sessionId);
  writer.append("run.started", { runId: accepted.runId }, { kind: "runtime", id: "test" });
  writer.append(
    "step.started",
    { runId: accepted.runId, stepId: "stp_stop_001" },
    { kind: "runtime", id: "test" },
  );
  writer.append(
    "step.completed",
    { runId: accepted.runId, stepId: "stp_stop_001", finishReason: "response" },
    { kind: "runtime", id: "test" },
  );
  writer.append(
    "run.completed",
    { runId: accepted.runId, completionKind: "response", evaluationIds: [] },
    { kind: "runtime", id: "test" },
  );
  control.askNextRunQuestion(sessionId, accepted.runId);
  const stopped = control.answerNextRunQuestion(sessionId, "stop");
  assert.equal(stopped.view.pendingQuestion, undefined);
  assert.equal(stopped.view.mode, "agent");

  const reasked = control.reaskNextRunQuestion(sessionId);
  assert.equal(reasked?.pendingQuestion?.kind, "next_run");
  assert.equal(reasked?.pendingQuestion?.nextPlanItemId, "pit_two00001");

  const continued = control.answerNextRunQuestion(sessionId, "continue");
  assert.ok(continued.runId);
  assert.equal(continued.view.runs[continued.runId].planBinding.planItemId, "pit_two00001");

  // Fresh session path for return_to_plan after first item.
  const sessionB = createId("ses");
  const storeB = new InMemoryEventStore();
  const controlB = new HumanControlService({ eventStore: storeB });
  controlB.ensureSession(sessionB, "return plan", "plan");
  controlB.recordPlanRevision(sessionB, {
    planId: createId("pln"),
    title: "Demo B",
    overview: "Two",
    artifactRef: "artifact://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    path: "/tmp/plan-b.md",
    items: [
      { planItemId: "pit_one00001", title: "One", description: "First", dependsOn: [] },
      { planItemId: "pit_two00001", title: "Two", description: "Second", dependsOn: [] },
    ],
  });
  const acceptedB = controlB.acceptPlanAndStartFirstRun(sessionB);
  const writerB = new EventWriter(storeB, sessionB);
  writerB.append("run.started", { runId: acceptedB.runId }, { kind: "runtime", id: "test" });
  writerB.append(
    "step.started",
    { runId: acceptedB.runId, stepId: "stp_ret_001" },
    { kind: "runtime", id: "test" },
  );
  writerB.append(
    "step.completed",
    { runId: acceptedB.runId, stepId: "stp_ret_001", finishReason: "response" },
    { kind: "runtime", id: "test" },
  );
  writerB.append(
    "run.completed",
    { runId: acceptedB.runId, completionKind: "response", evaluationIds: [] },
    { kind: "runtime", id: "test" },
  );
  controlB.askNextRunQuestion(sessionB, acceptedB.runId);
  const returned = controlB.answerNextRunQuestion(sessionB, "return_to_plan");
  assert.equal(returned.view.mode, "plan");
  assert.equal(returned.view.pendingQuestion, undefined);
});

test("toolsForMode never advertises plan_document outside Plan", () => {
  const registered = ["read", "write", "plan_document", "delegate", "shell"];
  assert.deepEqual(toolsForMode("ask", registered), ["read"]);
  assert.deepEqual(toolsForMode("plan", registered).sort(), ["delegate", "plan_document", "read"].sort());
  assert.deepEqual(toolsForMode("agent", registered).sort(), ["delegate", "read", "shell", "write"].sort());
});

test("capability broker denies tools that the frozen Run mode forbids", async () => {
  const broker = new InMemoryCapabilityBroker();
  broker.grant({
    leaseId: "lea_mode_write_001",
    subject: "agent",
    tools: ["write"],
    effects: ["write"],
    resources: ["file:**"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const denied = await broker.authorize({
    actionId: "act_1",
    subject: "agent",
    tool: "write",
    effect: "write",
    resources: ["file:a.ts"],
    mode: "ask",
  });
  assert.equal(denied.outcome, "denied");
  assert.match(denied.reason, /ask mode denies/i);

  const planWrite = await broker.authorize({
    actionId: "act_2",
    subject: "agent",
    tool: "write",
    effect: "write",
    resources: ["file:a.ts"],
    mode: "plan",
  });
  assert.equal(planWrite.outcome, "denied");

  broker.grant({
    leaseId: "lea_mode_plan_001",
    subject: "agent",
    tools: ["plan_document"],
    effects: ["write"],
    resources: ["plan:document"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const planDoc = await broker.authorize({
    actionId: "act_3",
    subject: "agent",
    tool: "plan_document",
    effect: "write",
    resources: ["plan:document"],
    mode: "plan",
  });
  assert.equal(planDoc.outcome, "granted");
  assert.equal(modeAllowsIntent("agent", "plan_document", "write").ok, false);
});

test("SessionSupervisor leaves a clean Plan-triggered Run resumable", () => {
  const store = new InMemoryEventStore();
  const sessionId = createId("ses");
  const control = new HumanControlService({ eventStore: store });
  control.ensureSession(sessionId, "resume", "plan");
  control.recordPlanRevision(sessionId, {
    planId: createId("pln"),
    title: "Resume",
    overview: "One item",
    artifactRef: "artifact://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    path: "/tmp/resume.md",
    items: [{ planItemId: "pit_resume001", title: "Only", description: "Do it", dependsOn: [] }],
  });
  const accepted = control.acceptPlanAndStartFirstRun(sessionId);
  const recovery = new SessionSupervisor(store).recover(sessionId);
  assert.equal(recovery.recovered, false);
  assert.equal(recovery.resumableRunId, accepted.runId);
  assert.equal(recovery.view.runs[accepted.runId].status, "triggered");
  assert.equal(recovery.pendingReview, false);
});
