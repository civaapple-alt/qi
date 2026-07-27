import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_MODE_TOOLS,
  InMemoryCapabilityBroker,
  PLAN_MODE_EXTRA_TOOLS,
  modeAllowsIntent,
} from "@civaapple/qi-capability";
import {
  InMemoryEventStore,
  KERNEL_ASK_MODE_TOOLS,
  KERNEL_PLAN_MODE_EXTRA_TOOLS,
  StateTransitionError,
  applySessionEvent,
} from "@civaapple/qi-kernel";
import { EventWriter, HumanControlService, SessionSupervisor, TurnLoop, toolsForMode } from "@civaapple/qi-loop";
import { createId } from "@civaapple/qi-protocol";
import { Type } from "@sinclair/typebox";
import { FileArtifactStore, ToolRegistry, defineTool } from "@civaapple/qi-tools";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import { createQiIntrospectionTool } from "@civaapple/qi-introspection";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("Plan mode allows read-only qi_introspect at the Kernel boundary", () => {
  const sessionId = "ses_plan_introspect_001";
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { mode: "plan" }, { kind: "runtime", id: "test" });
  writer.append(
    "run.triggered",
    { runId: "run_plan_intro_001", trigger: "user", mode: "plan", input: "inspect gaps" },
    { kind: "user", id: "u" },
  );
  writer.append("run.started", { runId: "run_plan_intro_001" }, { kind: "runtime", id: "test" });
  writer.append(
    "step.started",
    { runId: "run_plan_intro_001", stepId: "stp_plan_intro_001" },
    { kind: "runtime", id: "test" },
  );
  writer.append(
    "action.proposed",
    {
      runId: "run_plan_intro_001",
      stepId: "stp_plan_intro_001",
      actionId: "act_plan_intro_001",
      toolName: "qi_introspect",
      toolIdentity: "qi_introspect@1",
      input: { section: "gaps" },
      effect: "read",
      resources: ["qi:self-model:gaps"],
    },
    { kind: "agent", id: "agent" },
  );
  const view = store.load(sessionId);
  assert.equal(view?.runs.run_plan_intro_001?.actions.act_plan_intro_001?.status, "proposed");
  assert.equal(modeAllowsIntent("plan", "qi_introspect", "read").ok, true);
  assert.equal(toolsForMode("plan", ["read", "qi_introspect", "plan_document"]).includes("qi_introspect"), true);
});

test("Kernel and capability Ask/Plan tool allowlists stay in lockstep", () => {
  assert.deepEqual([...KERNEL_ASK_MODE_TOOLS].sort(), [...ASK_MODE_TOOLS].sort());
  assert.deepEqual([...KERNEL_PLAN_MODE_EXTRA_TOOLS].sort(), [...PLAN_MODE_EXTRA_TOOLS].sort());
});

test("Plan-mode TurnLoop executes qi_introspect and returns a final response", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-plan-introspect-"));
  const artifactRoot = join(root, ".artifacts");
  await mkdir(artifactRoot, { recursive: true });
  try {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_plan_introspect",
      subject: "agent_main",
      tools: ["qi_introspect"],
      effects: ["read"],
      resources: ["qi:self-model:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("qi_introspect", createQiIntrospectionTool());
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-plan-introspect",
          name: "qi_introspect",
          input: { section: "gaps" },
        },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const result = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result" && part.callId === "call-plan-introspect");
        assert.ok(result);
        assert.equal(result.isError, false);
        assert.equal(Array.isArray(result.output), true);
        const text = result.output.find((part) => part.type === "text")?.text;
        const introspection = JSON.parse(String(text));
        assert.equal(introspection.section, "gaps");
        assert.match(introspection.authorityNotice, /cannot grant capabilities/u);
        return [
          { type: "text.delta", delta: "Review findings are mapped to the current Qi gaps." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    const result = await loop.run({
      sessionId: "ses_plan_introspect_loop",
      title: "plan introspection",
      subject: "agent_main",
      input: "inspect the current gaps",
      model: { provider: "fake", model: "deterministic-v1" },
      contextBlocks: [
        {
          id: "constitution",
          kind: "constitution",
          source: "agent.md",
          role: "system",
          content: "Inspect Qi without widening authority.",
          priority: 100,
          required: true,
          retentionReason: "Agent identity",
        },
      ],
      contextBudgetTokens: 2_000,
      maxSteps: 3,
      mode: "plan",
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifactRoot),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Review findings are mapped to the current Qi gaps.");
    const events = store.read("ses_plan_introspect_loop").events;
    assert.equal(events.some((event) => event.type === "action.completed"), true);
    assert.equal(events.some((event) => event.type === "model.action.rejected"), false);
    assert.equal(events.some((event) => event.type === "run.parked"), false);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TurnLoop converts a Kernel mode denial into model correction feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-kernel-mode-recover-"));
  const artifactRoot = join(root, ".artifacts");
  await mkdir(artifactRoot, { recursive: true });
  try {
    const innerStore = new InMemoryEventStore();
    let rejectedProposal = false;
    const store = {
      read(sessionId) {
        return innerStore.read(sessionId);
      },
      load(sessionId) {
        return innerStore.load(sessionId);
      },
      append(sessionId, expectedVersion, events) {
        if (!rejectedProposal && events.some((event) => event.type === "action.proposed")) {
          rejectedProposal = true;
          throw new StateTransitionError("MODE_TOOL_DENIED", "Plan mode denies tool qi_introspect");
        }
        return innerStore.append(sessionId, expectedVersion, events);
      },
    };
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_kernel_mode_recover",
      subject: "agent_main",
      tools: ["qi_introspect"],
      effects: ["read"],
      resources: ["qi:self-model:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("qi_introspect", createQiIntrospectionTool());
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-kernel-denied",
          name: "qi_introspect",
          input: { section: "gaps" },
        },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const denied = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result" && part.callId === "call-kernel-denied");
        assert.ok(denied);
        assert.equal(denied.isError, true);
        assert.deepEqual(denied.output, {
          code: "TOOL_INPUT",
          reason: "Plan mode denies tool qi_introspect",
        });
        return [
          { type: "text.delta", delta: "Kernel rejected the call; returning a safe handoff." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    const result = await loop.run({
      sessionId: "ses_kernel_mode_recover",
      title: "kernel mode recover",
      subject: "agent_main",
      input: "inspect the current gaps",
      model: { provider: "fake", model: "deterministic-v1" },
      contextBlocks: [
        {
          id: "constitution",
          kind: "constitution",
          source: "agent.md",
          role: "system",
          content: "Recover mode denials as model feedback.",
          priority: 100,
          required: true,
          retentionReason: "Agent identity",
        },
      ],
      contextBudgetTokens: 2_000,
      maxSteps: 3,
      mode: "plan",
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifactRoot),
    });
    assert.equal(rejectedProposal, true);
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Kernel rejected the call; returning a safe handoff.");
    const events = innerStore.read("ses_kernel_mode_recover").events;
    assert.equal(events.some((event) => event.type === "action.proposed"), false);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
    assert.equal(
      events.some(
        (event) =>
          event.type === "model.action.rejected" &&
          event.actor.kind === "runtime" &&
          event.actor.id === "kernel",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TurnLoop recovers from Plan-mode effect denials without failing the Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mode-recover-"));
  const artifactRoot = join(root, ".artifacts");
  await mkdir(artifactRoot, { recursive: true });
  try {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_mode_recover_artifact",
      subject: "agent_main",
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    // Write-effect tool that remains name-advertised in Plan; modeAllowsIntent must reject it.
    registry.register(
      "artifact",
      defineTool({
        description: "store an artifact",
        input: Type.Object({
          content: Type.String({ minLength: 1 }),
          mediaType: Type.String({ minLength: 1 }),
        }),
        output: Type.Object({ ref: Type.String() }),
        effect: () => "write",
        resources: () => ["artifact-store:local"],
        execute: async () => {
          throw new Error("executor must not run for mode-denied Plan write");
        },
      }),
    );
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-plan-write",
          name: "artifact",
          input: { content: "nope", mediaType: "text/plain" },
        },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const denied = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result" && part.callId === "call-plan-write");
        assert.ok(denied);
        assert.equal(denied.isError, true);
        assert.equal(denied.output.code, "TOOL_INPUT");
        assert.match(String(denied.output.reason), /Plan mode denies write effects/i);
        return [
          { type: "text.delta", delta: "Plan mode blocked the write; staying read-only." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    const result = await loop.run({
      sessionId: "ses_mode_recover",
      title: "mode recover",
      subject: "agent_main",
      input: "store evidence in plan mode",
      model: { provider: "fake", model: "deterministic-v1" },
      contextBlocks: [
        {
          id: "constitution",
          kind: "constitution",
          source: "agent.md",
          role: "system",
          content: "Stay read-only in Plan.",
          priority: 100,
          required: true,
          retentionReason: "Agent identity",
        },
      ],
      contextBudgetTokens: 2_000,
      maxSteps: 3,
      mode: "plan",
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifactRoot),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Plan mode blocked the write; staying read-only.");
    const events = store.read("ses_mode_recover").events;
    assert.equal(events.some((event) => event.type === "model.action.rejected"), true);
    assert.equal(events.some((event) => event.type === "action.proposed"), false);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
    const step = result.view.runs[result.runId].steps[result.view.runs[result.runId].stepOrder[0]];
    assert.deepEqual(step.rejectedActionCalls, [
      {
        callId: "call-plan-write",
        toolName: "artifact",
        errorCode: "TOOL_INPUT",
        reason: "Plan mode denies write effects for artifact",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan mode still denies tools outside the Ask/Plan allowlist", () => {
  const sessionId = "ses_plan_deny_001";
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { mode: "plan" }, { kind: "runtime", id: "test" });
  writer.append(
    "run.triggered",
    { runId: "run_plan_deny_001", trigger: "user", mode: "plan", input: "shell" },
    { kind: "user", id: "u" },
  );
  writer.append("run.started", { runId: "run_plan_deny_001" }, { kind: "runtime", id: "test" });
  writer.append(
    "step.started",
    { runId: "run_plan_deny_001", stepId: "stp_plan_deny_001" },
    { kind: "runtime", id: "test" },
  );
  assert.throws(
    () => writer.append(
      "action.proposed",
      {
        runId: "run_plan_deny_001",
        stepId: "stp_plan_deny_001",
        actionId: "act_plan_deny_001",
        toolName: "shell",
        toolIdentity: "shell@1",
        input: { command: "node", args: ["-v"] },
        effect: "execute",
        resources: ["host-process:node"],
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
