import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { Coordinator, MultiAgentBaselineGate, runDelegatedTurn } from "@civaapple/qi-agent/extensions";
import { GoalEngine } from "@civaapple/qi-agent/eval";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter, SessionSupervisor, TurnLoop } from "@civaapple/qi-agent/loop";
import { FileArtifactStore, ToolRegistry, builtinTools } from "@civaapple/qi-node/tools";
import { Type } from "@sinclair/typebox";

const CONTEXT_REF = `artifact://${"a".repeat(64)}`;

function setup() {
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, "ses_parent_001");
  writer.append("session.created", {}, { kind: "user", id: "user" });
  writer.append("run.triggered", { runId: "run_parent_001", trigger: "user" }, { kind: "user", id: "user" });
  writer.append("run.started", { runId: "run_parent_001" }, { kind: "runtime", id: "qi" });
  const broker = new InMemoryCapabilityBroker();
  broker.grant({
    leaseId: "lea_parent_001",
    subject: "agent_parent",
    tools: ["read", "search"],
    effects: ["read"],
    resources: ["file:**", "tree:**"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    maxUses: 10,
  });
  const artifactRoot = mkdtempSync(join(tmpdir(), "qi-coord-"));
  const artifactStore = new FileArtifactStore(artifactRoot);
  return { store, broker, artifactStore, artifactRoot };
}

function grantDelegationReceipt(store, subject = "agent_parent") {
  const goals = new GoalEngine(store, "ses_parent_001");
  const goal = goals.create(
    {
      objective: "Allow depth-1 Subagent delegation",
      assertions: [{ assertionId: "delegation.settled", description: "Child settled" }],
    },
    {
      issuedTo: subject,
      startRight: "user",
      stopRight: "contract",
      acceptanceRight: "human",
      delegationRight: true,
      actionLeaseIds: ["lea_parent_001"],
    },
  );
  const receipt = Object.values(store.load("ses_parent_001").controlReceipts)
    .find((item) => item.goalId === goal.goalId && item.phase === "granted" && item.delegationRight);
  assert.ok(receipt);
  return receipt.receiptId;
}

function contract(overrides = {}) {
  return {
    outcome: "Find evidence for the claim",
    deliverableSchema: Type.Object({ answer: Type.String() }, { additionalProperties: false }),
    contextRefs: [CONTEXT_REF],
    parentLeaseId: "lea_parent_001",
    childLease: {
      tools: ["read"],
      effects: ["read"],
      resources: ["file:docs/**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxUses: 3,
    },
    resourceEnvelope: { contextTokens: 4_000, maxSteps: 3, wallTimeMs: 30_000 },
    evidenceRequired: [{ kind: "deterministic", minimum: 1 }],
    returnPolicy: "result+trace",
    ...overrides,
  };
}

test("Coordinator creates an isolated child Session with a narrowed lease and evidence-gated return", async () => {
  const { store, broker, artifactStore, artifactRoot } = setup();
  try {
    const receiptId = grantDelegationReceipt(store);
    const coordinator = new Coordinator({
      store,
      broker,
      parentSessionId: "ses_parent_001",
      runId: "run_parent_001",
      artifactStore,
      brancher: { async createBranch(id) { return { ref: `branch://${id}` }; } },
    });
    await assert.rejects(
      coordinator.delegate(contract(), { receiptId: "rcp_missing_001", parentSubject: "agent_parent" }),
      /was not found/,
    );
    const handle = await coordinator.delegate(contract(), { receiptId, parentSubject: "agent_parent" });
    assert.match(handle.workspaceBranch, /^branch:\/\//);
    assert.match(handle.contractRef, /^artifact:\/\//);
    assert.equal(store.load(handle.childSessionId).title.startsWith("Delegated:"), true);
    const recorded = store.load("ses_parent_001").runs.run_parent_001.delegations[handle.delegationId];
    assert.equal(recorded.depth, 1);
    assert.equal(recorded.receiptId, receiptId);
    assert.deepEqual(recorded.contextRefs, [CONTEXT_REF]);
    const childRead = await broker.authorize({
      actionId: "act_child_001",
      subject: handle.childSubject,
      tool: "read",
      effect: "read",
      resources: ["file:docs/a.md"],
    });
    assert.equal(childRead.outcome, "granted");
    const coordinatorPower = await broker.authorize({
      actionId: "act_child_002",
      subject: handle.childSubject,
      tool: "coordinator.delegate",
      effect: "read",
      resources: ["file:docs/a.md"],
    });
    assert.equal(coordinatorPower.outcome, "denied");
    const parentWriter = new EventWriter(store, "ses_parent_001");
    assert.throws(
      () => parentWriter.append("run.failed", { runId: "run_parent_001", code: "EARLY_EXIT" }, { kind: "runtime", id: "coordinator" }),
      /still running/,
    );
    const returned = coordinator.return(handle, {
      result: { answer: "verified" },
      resultRef: "artifact://result",
      traceRef: "artifact://trace",
      evidence: [{ kind: "deterministic", ref: "artifact://test" }],
    });
    assert.deepEqual(returned, { accepted: true, reasons: [] });
    const delegation = store.load("ses_parent_001").runs.run_parent_001.delegations[handle.delegationId];
    assert.equal(delegation.status, "accepted");
    assert.deepEqual(delegation.evidenceRefs.sort(), ["artifact://test", "artifact://trace"]);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("Delegated leases cannot expand parent authority", async () => {
  const { store, broker, artifactStore, artifactRoot } = setup();
  try {
    const receiptId = grantDelegationReceipt(store);
    const coordinator = new Coordinator({
      store,
      broker,
      parentSessionId: "ses_parent_001",
      runId: "run_parent_001",
      artifactStore,
    });
    await assert.rejects(
      coordinator.delegate(
        contract({
          childLease: {
            tools: ["write"],
            effects: ["write"],
            resources: ["file:**"],
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }),
        { receiptId, parentSubject: "agent_parent" },
      ),
      /exceed/,
    );
    assert.equal(Object.keys(store.load("ses_parent_001").runs.run_parent_001.delegations).length, 0);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("Session recovery cancels running delegations before parking the parent Run", async () => {
  const { store, broker, artifactStore, artifactRoot } = setup();
  try {
    const receiptId = grantDelegationReceipt(store);
    const coordinator = new Coordinator({
      store,
      broker,
      parentSessionId: "ses_parent_001",
      runId: "run_parent_001",
      artifactStore,
    });
    const handle = await coordinator.delegate(contract(), { receiptId, parentSubject: "agent_parent" });
    const supervisor = new SessionSupervisor(store);
    const recovered = supervisor.recover("ses_parent_001");
    assert.equal(recovered.recovered, true);
    const delegation = store.load("ses_parent_001").runs.run_parent_001.delegations[handle.delegationId];
    assert.equal(delegation.status, "cancelled");
    assert.equal(store.load("ses_parent_001").runs.run_parent_001.status, "parked");
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("runDelegatedTurn executes an isolated child Turn and returns summary Artifact refs only", async () => {
  const { store, broker, artifactStore, artifactRoot } = setup();
  try {
    const contextBody = await artifactStore.put(Buffer.from("only this context", "utf8"), "text/plain");
    const receiptId = grantDelegationReceipt(store);
    const registry = new ToolRegistry(broker);
    registry.register("read", builtinTools.read);
    const modelPort = {
      async *stream() {
        yield { type: "text.delta", delta: "child-answer" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const turnLoop = new TurnLoop({ eventStore: store, modelPort, toolRegistry: registry });
    const coordinator = new Coordinator({
      store,
      broker,
      parentSessionId: "ses_parent_001",
      runId: "run_parent_001",
      artifactStore,
    });
    const result = await runDelegatedTurn(
      contract({
        contextRefs: [contextBody.ref],
        deliverableSchema: Type.Object({
          summary: Type.String(),
          status: Type.String(),
        }, { additionalProperties: false }),
        evidenceRequired: [],
        returnPolicy: "result",
        resourceEnvelope: { contextTokens: 2_000, maxSteps: 1, wallTimeMs: 10_000 },
      }),
      { receiptId, parentSubject: "agent_parent" },
      {
        coordinator,
        turnLoop,
        model: { provider: "test", model: "mock" },
        workspaceRoot: artifactRoot,
        artifactStore,
        toolRegistry: registry,
        input: "Summarize the allowlisted context.",
      },
    );
    assert.equal(result.settlement.accepted, true);
    assert.equal(result.turn.text, "child-answer");
    assert.match(result.summaryRef, /^artifact:\/\//);
    assert.match(result.resultRef, /^artifact:\/\//);
    const parentEvents = store.read("ses_parent_001").events.map((event) => event.type);
    assert.ok(parentEvents.includes("delegation.created"));
    assert.ok(parentEvents.includes("delegation.returned"));
    assert.equal(
      store.load("ses_parent_001").runs.run_parent_001.delegations[result.handle.delegationId].status,
      "accepted",
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("Multi-Agent remains off by default until paired target evals show a measured advantage", () => {
  const gate = new MultiAgentBaselineGate(3);
  for (let index = 0; index < 2; index++) {
    gate.record({
      evalId: "research-quality",
      budget: 100,
      single: { passed: false, resourceUsed: 90, contextTokens: 900, wallTimeMs: 100 },
      multi: { passed: true, resourceUsed: 95, contextTokens: 700, wallTimeMs: 120, coordinationWallTimeMs: 20 },
    });
  }
  assert.equal(gate.decision("research-quality").enabledByDefault, false);
  gate.record({
    evalId: "research-quality",
    budget: 100,
    single: { passed: true, resourceUsed: 88, contextTokens: 800, wallTimeMs: 100 },
    multi: { passed: true, resourceUsed: 97, contextTokens: 650, wallTimeMs: 120, coordinationWallTimeMs: 25 },
  });
  const decision = gate.decision("research-quality");
  assert.equal(decision.enabledByDefault, true);
  assert.ok(decision.multiPassRate > decision.singlePassRate);
  assert.equal(decision.trials, 3);
});
