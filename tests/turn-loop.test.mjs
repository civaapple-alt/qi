import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TurnLoop } from "@civaapple/qi-agent/loop";
import {
  FileArtifactStore,
  ToolRegistry,
  artifactTool,
  defineTool,
  editTool,
  readTool,
  searchTool,
  writeTool,
} from "@civaapple/qi-node/tools";
import { effectIdempotencyKey } from "@civaapple/qi-node/workspace";

function delayedReadTool(activity) {
  return defineTool({
    description: "test-only read tool that reports concurrency and honors cooperative cancellation",
    input: Type.Object({ delayMs: Type.Number(), id: Type.String() }, { additionalProperties: false }),
    output: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    effect: () => "read",
    resources: (input) => [`test:${input.id}`],
    execute: async (input, context) => {
      activity.active += 1;
      activity.maxActive = Math.max(activity.maxActive, activity.active);
      try {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, input.delayMs));
        if (context.signal?.aborted) throw context.signal.reason ?? new DOMException("Cancelled", "AbortError");
        return { id: input.id };
      } finally {
        activity.active -= 1;
      }
    },
  });
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-loop-test-"));
  const artifactRoot = join(root, ".artifacts");
  await mkdir(artifactRoot, { recursive: true });
  try {
    await run({ root, artifactStore: new FileArtifactStore(artifactRoot) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function turnRequest(root, artifactStore, overrides = {}) {
  return {
    sessionId: "ses_turn_test",
    title: "Turn loop test",
    subject: "agent_main",
    input: "Help with this task",
    model: { provider: "fake", model: "deterministic-v1" },
    contextBlocks: [
      {
        id: "constitution",
        kind: "constitution",
        source: "agent.md",
        role: "system",
        content: "Act only with evidence.",
        priority: 100,
        required: true,
        retentionReason: "Agent identity",
      },
    ],
    contextBudgetTokens: 2_000,
    maxSteps: 3,
    workspaceRoot: root,
    artifactStore,
    ...overrides,
  };
}

test("TurnLoop completes a response-only Run with durable context and model boundaries", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const activities = [];
    const model = new ScriptedModelPort([
      [
        { type: "reasoning.delta", delta: "A short reason" },
        { type: "text.delta", delta: "A grounded answer" },
        { type: "usage", inputTokens: 24, outputTokens: 4 },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const loop = new TurnLoop({
      eventStore: store,
      modelPort: model,
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
      onActivity: (activity) => activities.push(activity),
    });

    const result = await loop.run(turnRequest(root, artifactStore));
    assert.equal(result.status, "completed");
    assert.equal(result.text, "A grounded answer");
    const events = store.read("ses_turn_test").events;
    assert.deepEqual(events.map((event) => event.type), [
      "session.created",
      "run.triggered",
      "run.started",
      "step.started",
      "context.compiled",
      "model.completed",
      "step.completed",
      "run.completed",
    ]);
    const run = result.view.runs[result.runId];
    const step = run.steps[run.stepOrder[0]];
    assert.equal(step.context.includedBlockIds.includes("constitution"), true);
    assert.equal(step.context.includedBlockIds.includes("tool-catalog"), true);
    assert.equal(step.model.text, "A grounded answer");
    assert.equal(step.model.reasoning, "A short reason");
    assert.deepEqual(
      activities.map((activity) => [activity.type, activity.text]),
      [
        ["model.reasoning", "A short reason"],
        ["model.text", "A grounded answer"],
      ],
    );
  });
});

test("TurnLoop reserves the final Step for a zero-Action handoff and carries it into the next Run", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    const model = new ScriptedModelPort([
      (request) => {
        assert.match(JSON.stringify(request.messages), /next and final Step is reserved/i);
        return [
          { type: "action.requested", callId: "call_read_before_handoff", name: "read", input: { path: "README.md" } },
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        assert.equal(request.tools.length, 0);
        assert.match(JSON.stringify(request.messages), /final Step 2 of 2/i);
        return [
          { type: "text.delta", delta: "Completed: inspected the request. Blocked: read lease denied. Next: grant read and continue. Verification: none run." },
          { type: "action.requested", callId: "call_forbidden_final", name: "read", input: { path: "README.md" } },
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        const history = request.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.match(history, /previous Run was paused for budget; it was not completed/i);
        assert.match(history, /Blocked: read lease denied/);
        return [
          { type: "text.delta", delta: "Continuing from the explicit budget handoff." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const parked = await loop.run(turnRequest(root, artifactStore, {
      maxSteps: 2,
      reserveFinalHandoff: true,
    }));
    assert.equal(parked.status, "parked");
    const parkedRun = parked.view.runs[parked.runId];
    assert.deepEqual(
      parkedRun.stepOrder.map((stepId) => parkedRun.steps[stepId].finishReason),
      ["action-requested", "handoff"],
    );
    assert.equal(Object.keys(parkedRun.actions).length, 1);
    const finalStep = parkedRun.steps[parkedRun.stepOrder.at(-1)];
    assert.deepEqual(finalStep.rejectedActionCalls.map((call) => call.errorCode), ["ACTION_BATCH_LIMIT"]);

    const continued = await loop.run(turnRequest(root, artifactStore, {
      input: "Continue the unfinished work.",
      maxSteps: 2,
      reserveFinalHandoff: true,
    }));
    assert.equal(continued.status, "completed");
    assert.equal(continued.text, "Continuing from the explicit budget handoff.");
  });
});

test("TurnLoop restores bounded completed conversation history across Runs", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const model = new ScriptedModelPort([
      [
        { type: "text.delta", delta: "Web is currently a read-only workbench." },
        { type: "completed", finishReason: "stop" },
      ],
      (request) => {
        assert.deepEqual(request.messages.map((message) => message.role), [
          "system",
          "user",
          "assistant",
          "user",
        ]);
        assert.deepEqual(
          request.messages.slice(1).map((message) => message.content[0].text),
          [
            "Does Web support chat?",
            "Web is currently a read-only workbench.",
            "What did I just ask?",
          ],
        );
        return [
          { type: "text.delta", delta: "You asked whether Web supports chat." },
          { type: "completed", finishReason: "stop" },
        ];
      },
      (request) => {
        assert.deepEqual(request.messages.map((message) => message.role), ["system", "user"]);
        return [
          { type: "text.delta", delta: "History was intentionally omitted." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({
      eventStore: store,
      modelPort: model,
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    });

    await loop.run(turnRequest(root, artifactStore, { input: "Does Web support chat?" }));
    const recalled = await loop.run(turnRequest(root, artifactStore, { input: "What did I just ask?" }));
    assert.equal(recalled.text, "You asked whether Web supports chat.");
    const recalledRun = recalled.view.runs[recalled.runId];
    assert.deepEqual(
      recalledRun.steps[recalledRun.stepOrder[0]].context.includedBlockIds.slice(-3),
      ["history:0", "history:1", "conversation:0"],
    );

    const omitted = await loop.run(turnRequest(root, artifactStore, {
      input: "Do not restore history.",
      historyBudgetTokens: 0,
    }));
    const omittedRun = omitted.view.runs[omitted.runId];
    assert.deepEqual(
      omittedRun.steps[omittedRun.stepOrder[0]].context.omittedBlockIds
        .filter((id) => id.startsWith("history:omitted:")),
      recalled.view.runOrder.slice(0, 2).map((runId) => `history:omitted:${runId}`),
    );
  });
});

test("TurnLoop persists authority and action start before entering the executor", async () => {
  await withRuntime(async ({ root, artifactStore: fileArtifacts }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_artifact_write",
      subject: "agent_main",
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("artifact", artifactTool);
    let observedBeforeExecution = false;
    const observingArtifacts = {
      async put(content, mediaType) {
        const last = store.read("ses_turn_test").events.at(-1);
        observedBeforeExecution = last?.type === "action.started";
        return fileArtifacts.put(content, mediaType);
      },
      get: (ref) => fileArtifacts.get(ref),
    };
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-artifact-1",
          name: "artifact",
          input: { content: "evidence", mediaType: "text/plain" },
        },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const resultPart = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result" && part.callId === "call-artifact-1");
        assert.ok(resultPart);
        assert.equal(resultPart.isError, false);
        return [
          { type: "text.delta", delta: "Evidence stored." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, observingArtifacts));
    assert.equal(result.status, "completed");
    assert.equal(observedBeforeExecution, true);
    const types = store.read("ses_turn_test").events.map((event) => event.type);
    const granted = types.indexOf("authority.granted");
    const started = types.indexOf("action.started");
    const completed = types.indexOf("action.completed");
    assert.ok(granted >= 0 && granted < started && started < completed);
    const actionEvent = store
      .read("ses_turn_test")
      .events.find((event) => event.type === "action.completed");
    assert.match(actionEvent.data.outputRef, /^artifact:\/\//);
  });
});

test("TurnLoop feeds a denied action back to the model without entering the executor", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry(new InMemoryCapabilityBroker());
    registry.register("read", readTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-read-1", name: "read", input: { path: "secret.txt" } },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const denied = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result" && part.callId === "call-read-1");
        assert.ok(denied);
        assert.equal(denied.isError, true);
        assert.equal(denied.output.code, "AUTHORITY_DENIED");
        return [
          { type: "text.delta", delta: "I cannot read that file without a lease." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, artifactStore));
    assert.equal(result.status, "completed");
    const types = store.read("ses_turn_test").events.map((event) => event.type);
    assert.equal(types.includes("authority.denied"), true);
    assert.equal(types.includes("authority.granted"), false);
    assert.equal(types.includes("action.started"), false);
  });
});

test("TurnLoop parks at a hard Step boundary instead of spinning", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry(new InMemoryCapabilityBroker());
    registry.register("read", readTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-read-loop", name: "read", input: { path: "missing.txt" } },
        { type: "completed", finishReason: "actions" },
      ],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, artifactStore, { maxSteps: 1 }));
    assert.equal(result.status, "parked");
    assert.deepEqual(result.view.runs[result.runId].terminal, {
      type: "parked",
      reason: "budget",
      detail: "Reached maxSteps=1",
    });
  });
});

test("TurnLoop compacts an oversized settled exchange into an auditable Artifact", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_compact_artifact",
      subject: "agent_main",
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("artifact", artifactTool);
    const largePayload = `compact-me-${"x".repeat(8_000)}`;
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-compact-1",
          name: "artifact",
          input: { content: largePayload, mediaType: "text/plain" },
        },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const serialized = JSON.stringify(request.messages);
        assert.doesNotMatch(serialized, /compact-me-/);
        assert.match(serialized, /qi-context-compact/);
        assert.match(serialized, /artifact:\/\/[a-f0-9]{64}/);
        return [
          { type: "text.delta", delta: "Continued after compacting settled context." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, artifactStore, {
      contextBudgetTokens: 1_000,
      maxSteps: 2,
    }));
    assert.equal(result.status, "completed");
    const compacted = store.read("ses_turn_test").events.find((event) => event.type === "context.compacted");
    assert.ok(compacted);
    assert.equal(compacted.data.reason, "hard-limit");
    assert.ok(compacted.data.originalEstimatedTokens > compacted.data.compactedEstimatedTokens);
    const archived = await artifactStore.get(compacted.data.artifactRef);
    assert.match(archived.content.toString("utf8"), /compact-me-/);
    const run = result.view.runs[result.runId];
    assert.equal(run.steps[run.stepOrder[1]].compactions.length, 1);
  });
});

test("TurnLoop compacts consumed exchanges before touching the newest tool feedback", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_pressure_artifact",
      subject: "agent_main",
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("artifact", artifactTool);
    const oldPayload = `old-exchange-${"o".repeat(6_000)}`;
    const newestPayload = `newest-exchange-${"n".repeat(6_000)}`;
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-old", name: "artifact", input: { content: oldPayload, mediaType: "text/plain" } },
        { type: "completed", finishReason: "actions" },
      ],
      [
        { type: "action.requested", callId: "call-newest", name: "artifact", input: { content: newestPayload, mediaType: "text/plain" } },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const serialized = JSON.stringify(request.messages);
        assert.doesNotMatch(serialized, /old-exchange-/);
        assert.match(serialized, /newest-exchange-/);
        return [
          { type: "text.delta", delta: "Pressure compaction preserved the newest feedback." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    const result = await loop.run(turnRequest(root, artifactStore, {
      contextBudgetTokens: 4_000,
      maxSteps: 3,
    }));
    assert.equal(result.status, "completed");
    const compactions = store.read("ses_turn_test").events.filter((event) => event.type === "context.compacted");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].data.reason, "pressure");
  });
});

test("TurnLoop parks when required context cannot fit after compaction", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const loop = new TurnLoop({
      eventStore: store,
      modelPort: new ScriptedModelPort([]),
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    });
    const result = await loop.run(turnRequest(root, artifactStore, {
      input: "x".repeat(8_000),
      contextBudgetTokens: 500,
    }));
    assert.equal(result.status, "parked");
    assert.equal(result.view.runs[result.runId].terminal?.type, "parked");
    assert.equal(result.view.runs[result.runId].terminal?.reason, "budget");
    assert.match(result.view.runs[result.runId].terminal?.detail ?? "", /./);
  });
});

test("TurnLoop fails closed when the model requests an unadvertised tool", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-ghost", name: "ghost", input: {} },
        { type: "completed", finishReason: "actions" },
      ],
    ]);
    const loop = new TurnLoop({
      eventStore: store,
      modelPort: model,
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    });

    const result = await loop.run(turnRequest(root, artifactStore));
    assert.equal(result.status, "failed");
    assert.deepEqual(result.view.runs[result.runId].terminal, {
      type: "failed",
      reason: "INVALID_MODEL_ACTION",
    });
  });
});

test("TurnLoop feeds invalid advertised tool input back for model correction", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry(new InMemoryCapabilityBroker());
    registry.register("search", searchTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-invalid-search", name: "search", input: { query: "" } },
        { type: "completed", finishReason: "actions" },
      ],
      [
        { type: "text.delta", delta: "I need a non-empty search query." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, artifactStore));
    assert.equal(result.status, "completed");
    assert.equal(result.text, "I need a non-empty search query.");
    const events = store.read("ses_turn_test").events;
    assert.equal(events.some((event) => event.type === "model.action.rejected"), true);
    assert.equal(events.some((event) => event.type === "action.started"), false);
    const firstStep = result.view.runs[result.runId].steps[result.view.runs[result.runId].stepOrder[0]];
    assert.deepEqual(firstStep.rejectedActionCalls, [
      {
        callId: "call-invalid-search",
        toolName: "search",
        errorCode: "TOOL_INPUT",
        reason: "/query: Expected string length greater or equal to 1",
      },
    ]);
    const feedback = model.requests[1].messages.find(
      (message) => message.role === "tool" && message.content[0]?.type === "tool-result",
    );
    assert.equal(feedback.content[0].isError, true);
    assert.equal(feedback.content[0].output.code, "TOOL_INPUT");
  });
});

test("TurnLoop bounds each model action batch and preserves feedback source order", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry(new InMemoryCapabilityBroker());
    registry.register("read", readTool);
    const calls = ["one.txt", "two.txt", "three.txt"].map((path, index) => ({
      type: "action.requested",
      callId: `call-bounded-${index + 1}`,
      name: "read",
      input: { path },
    }));
    const model = new ScriptedModelPort([
      [...calls, { type: "completed", finishReason: "actions" }],
      [
        { type: "text.delta", delta: "The action batch was bounded." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(
      turnRequest(root, artifactStore, { maxActionsPerStep: 2 }),
    );
    assert.equal(result.status, "completed");
    const rejected = store
      .read("ses_turn_test")
      .events.find((event) => event.type === "model.action.rejected");
    assert.equal(rejected.data.errorCode, "ACTION_BATCH_LIMIT");
    assert.equal(rejected.data.callId, "call-bounded-3");
    const feedbackCallIds = model.requests[1].messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content[0].callId);
    assert.deepEqual(feedbackCallIds, ["call-bounded-1", "call-bounded-2", "call-bounded-3"]);
  });
});

test("TurnLoop settles unstarted batch actions before parking an indeterminate effect", async () => {
  await withRuntime(async ({ root, artifactStore: fileArtifacts }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_batch_artifacts",
      subject: "agent_main",
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("artifact", artifactTool);
    let putCalls = 0;
    const failingArtifacts = {
      async put(content, mediaType) {
        putCalls += 1;
        if (putCalls === 1) throw new Error("storage connection disappeared");
        return fileArtifacts.put(content, mediaType);
      },
      get: (ref) => fileArtifacts.get(ref),
    };
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-batch-1",
          name: "artifact",
          input: { content: "first", mediaType: "text/plain" },
        },
        {
          type: "action.requested",
          callId: "call-batch-2",
          name: "artifact",
          input: { content: "second", mediaType: "text/plain" },
        },
        { type: "completed", finishReason: "actions" },
      ],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, failingArtifacts));
    assert.equal(result.status, "parked");
    assert.equal(putCalls, 1);
    const actions = Object.values(result.view.runs[result.runId].actions);
    assert.deepEqual(actions.map((action) => action.status), ["indeterminate", "denied"]);
    assert.deepEqual(result.view.runs[result.runId].terminal, {
      type: "parked",
      reason: "indeterminate-effect",
      detail: "Tool settlement could not be confirmed",
    });
  });
});

test("TurnLoop executes a Step's consecutive read Actions concurrently", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_slow_read",
      subject: "agent_main",
      tools: ["slow_read"],
      effects: ["read"],
      resources: ["test:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    const activity = { active: 0, maxActive: 0 };
    registry.register("slow_read", delayedReadTool(activity));
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-slow-1", name: "slow_read", input: { id: "a", delayMs: 80 } },
        { type: "action.requested", callId: "call-slow-2", name: "slow_read", input: { id: "b", delayMs: 20 } },
        { type: "action.requested", callId: "call-slow-3", name: "slow_read", input: { id: "c", delayMs: 50 } },
        { type: "completed", finishReason: "actions" },
      ],
      [
        { type: "text.delta", delta: "All three reads settled." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });

    const result = await loop.run(turnRequest(root, artifactStore));

    assert.equal(result.status, "completed");
    assert.equal(activity.maxActive, 3);

    const actions = Object.values(result.view.runs[result.runId].actions);
    assert.deepEqual(actions.map((action) => action.status), ["completed", "completed", "completed"]);
    // Even though call-slow-2 (10ms) and call-slow-3 (20ms) settle before call-slow-1 (30ms), the tool-result
    // feedback fed back to the model preserves the model's original request order.
    const feedbackCallIds = model.requests[1].messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content[0].callId);
    assert.deepEqual(feedbackCallIds, ["call-slow-1", "call-slow-2", "call-slow-3"]);
  });
});

test("TurnLoop stops a concurrent read batch and denies the rest of the Step on cancellation", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_cancel_write",
      subject: "agent_main",
      tools: ["artifact"],
      effects: ["write"],
      resources: ["artifact-store:local"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    broker.grant({
      leaseId: "lea_cancel_read",
      subject: "agent_main",
      tools: ["slow_read"],
      effects: ["read"],
      resources: ["test:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    const activity = { active: 0, maxActive: 0 };
    registry.register("slow_read", delayedReadTool(activity));
    registry.register("artifact", artifactTool);
    const controller = new AbortController();
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-cancel-1", name: "slow_read", input: { id: "a", delayMs: 20 } },
        { type: "action.requested", callId: "call-cancel-2", name: "slow_read", input: { id: "b", delayMs: 20 } },
        {
          type: "action.requested",
          callId: "call-cancel-3",
          name: "artifact",
          input: { content: "unreachable", mediaType: "text/plain" },
        },
        { type: "completed", finishReason: "actions" },
      ],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    setTimeout(() => controller.abort(new Error("User interrupted")), 5);

    const result = await loop.run(turnRequest(root, artifactStore, { signal: controller.signal }));

    assert.equal(result.status, "cancelled");
    const actions = Object.values(result.view.runs[result.runId].actions);
    assert.deepEqual(actions.map((action) => action.status), ["cancelled", "cancelled", "denied"]);
    const denied = store
      .read("ses_turn_test")
      .events.filter((event) => event.type === "authority.denied")
      .map((event) => event.data.reason);
    assert.deepEqual(denied, ["Batch cancelled before this action started"]);
  });
});

test("TurnLoop rebases consecutive same-Step edits against the latest successful digest", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const target = join(root, "same-file.txt");
    const original = "alpha\nomega\ntail\n";
    await writeFile(target, original, "utf8");
    const sha256 = createHash("sha256").update(original, "utf8").digest("hex");

    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_batch_edit",
      subject: "agent_main",
      tools: ["edit"],
      effects: ["write"],
      resources: ["file:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("edit", editTool);
    const journalBegins = [];
    const journal = {
      begin(input) {
        journalBegins.push(structuredClone(input));
        return {
          outcome: "acquired",
          record: {
            ...input,
            status: "reserved",
            attempts: 1,
            updatedAt: new Date(0).toISOString(),
          },
        };
      },
      markStarted() {},
      complete() {},
      fail() {},
      indeterminate() {},
      reconcile() {},
      get() { return undefined; },
    };
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call-edit-1",
          name: "edit",
          input: {
            path: "same-file.txt",
            oldText: "alpha",
            newText: "beta",
            expectedSha256: sha256,
          },
        },
        {
          type: "action.requested",
          callId: "call-edit-2",
          name: "edit",
          input: {
            path: "same-file.txt",
            oldText: "omega",
            newText: "sigma",
            expectedSha256: sha256,
          },
        },
        {
          type: "action.requested",
          callId: "call-edit-3",
          name: "edit",
          input: {
            path: "same-file.txt",
            oldText: "tail",
            newText: "end",
            expectedSha256: sha256,
          },
        },
        { type: "completed", finishReason: "actions" },
      ],
      [{ type: "text.delta", delta: "All edits completed." }, { type: "completed", finishReason: "stop" }],
    ]);
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    const result = await loop.run(turnRequest(root, artifactStore, {
      maxSteps: 2,
      effectJournal: journal,
    }));
    assert.equal(result.status, "completed");
    const actions = Object.values(result.view.runs[result.runId].actions);
    assert.deepEqual(
      actions.map((action) => ({ tool: action.toolName, status: action.status, detail: action.terminalDetail })),
      [
        { tool: "edit", status: "completed", detail: undefined },
        { tool: "edit", status: "completed", detail: undefined },
        { tool: "edit", status: "completed", detail: undefined },
      ],
    );
    assert.equal(await readFile(target, "utf8"), "beta\nsigma\nend\n");
    const events = store.read("ses_turn_test").events;
    const rebases = events.filter((event) => event.type === "action.freshness.rebased");
    assert.equal(rebases.length, 2);
    for (const rebase of rebases) {
      const rebaseIndex = events.indexOf(rebase);
      const priorCompletedIndex = events.findIndex(
        (event) => event.type === "action.completed" && event.data.actionId === rebase.data.priorActionId,
      );
      const authorityIndex = events.findIndex(
        (event) => event.type === "authority.requested" && event.data.actionId === rebase.data.actionId,
      );
      const startedIndex = events.findIndex(
        (event) => event.type === "action.started" && event.data.actionId === rebase.data.actionId,
      );
      assert.ok(priorCompletedIndex < rebaseIndex);
      assert.ok(rebaseIndex < authorityIndex);
      assert.ok(authorityIndex < startedIndex);
      assert.equal(result.view.runs[result.runId].actions[rebase.data.actionId].freshnessRebase.priorActionId, rebase.data.priorActionId);
    }
    const rebasedOutputs = events
      .filter((event) => event.type === "action.completed")
      .map((event) => event.data.modelOutput?.[0]?.text)
      .filter(Boolean)
      .map((text) => JSON.parse(text))
      .filter((output) => output.freshnessRebased);
    assert.equal(rebasedOutputs.length, 2);
    const afterFirst = createHash("sha256").update("beta\nomega\ntail\n", "utf8").digest("hex");
    assert.equal(
      journalBegins[1].idempotencyKey,
      effectIdempotencyKey(
        result.runId,
        "edit",
        {
          path: "same-file.txt",
          oldText: "omega",
          newText: "sigma",
          expectedSha256: afterFirst,
        },
        ["file:same-file.txt"],
      ),
    );
  });
});

test("TurnLoop rebases safely but does not fuzzy-merge an overlapping edit target", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const { writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const original = "alpha\n";
    await writeFile(join(root, "overlap.txt"), original, "utf8");
    const sha256 = createHash("sha256").update(original, "utf8").digest("hex");
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_overlap_edit",
      subject: "agent_main",
      tools: ["edit"],
      effects: ["write"],
      resources: ["file:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("edit", editTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-overlap-1", name: "edit", input: { path: "overlap.txt", oldText: "alpha", newText: "beta", expectedSha256: sha256 } },
        { type: "action.requested", callId: "call-overlap-2", name: "edit", input: { path: "overlap.txt", oldText: "alpha", newText: "gamma", expectedSha256: sha256 } },
        { type: "completed", finishReason: "actions" },
      ],
      [{ type: "text.delta", delta: "The overlapping target no longer exists." }, { type: "completed", finishReason: "stop" }],
    ]);
    const result = await new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry })
      .run(turnRequest(root, artifactStore, { maxSteps: 2 }));
    const actions = Object.values(result.view.runs[result.runId].actions);
    assert.deepEqual(actions.map((action) => action.status), ["completed", "failed"]);
    assert.equal(actions[1].terminalDetail, "EDIT_TARGET_NOT_FOUND");
    assert.equal(store.read("ses_turn_test").events.some((event) => event.type === "action.freshness.rebased"), true);
  });
});

test("TurnLoop keeps mixed same-resource mutations behind BATCH_WRITE_CONFLICT", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const { writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const original = "alpha\n";
    await writeFile(join(root, "mixed.txt"), original, "utf8");
    const sha256 = createHash("sha256").update(original, "utf8").digest("hex");
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_mixed_write",
      subject: "agent_main",
      tools: ["edit", "write"],
      effects: ["write"],
      resources: ["file:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("edit", editTool);
    registry.register("write", writeTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call-mixed-edit", name: "edit", input: { path: "mixed.txt", oldText: "alpha", newText: "beta", expectedSha256: sha256 } },
        { type: "action.requested", callId: "call-mixed-write", name: "write", input: { path: "mixed.txt", content: "gamma\n", expectedSha256: sha256 } },
        { type: "action.requested", callId: "call-after-mixed", name: "edit", input: { path: "mixed.txt", oldText: "beta", newText: "delta", expectedSha256: sha256 } },
        { type: "completed", finishReason: "actions" },
      ],
      [{ type: "text.delta", delta: "The mixed write was rejected." }, { type: "completed", finishReason: "stop" }],
    ]);
    const result = await new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry })
      .run(turnRequest(root, artifactStore, { maxSteps: 2 }));
    const actions = Object.values(result.view.runs[result.runId].actions);
    assert.deepEqual(actions.map((action) => action.status), ["completed", "failed", "failed"]);
    assert.equal(actions[1].terminalDetail, "BATCH_WRITE_CONFLICT");
    assert.equal(actions[2].terminalDetail, "BATCH_WRITE_CONFLICT");
    assert.equal(store.read("ses_turn_test").events.some((event) => event.type === "action.freshness.rebased"), false);
  });
});

test("TurnLoop applies steering at the next safe Step boundary", async () => {
  await withRuntime(async ({ root, artifactStore }) => {
    const store = new InMemoryEventStore();
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    const firstCanFinish = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const model = {
      async capabilities() {
        return {
          input: new Set(["text"]),
          output: new Set(["text"]),
          contextTokens: 10_000,
          parallelActions: false,
          promptCache: false,
        };
      },
      async *stream(request) {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstCanFinish;
          yield { type: "text.delta", delta: "Initial answer" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        const steering = request.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => message.content)
          .find((part) => part.type === "text" && part.text === "Focus on the safety boundary");
        assert.ok(steering);
        yield { type: "text.delta", delta: "Revised around the safety boundary" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const loop = new TurnLoop({
      eventStore: store,
      modelPort: model,
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    });

    const running = loop.run(turnRequest(root, artifactStore));
    await firstStarted;
    loop.steer("ses_turn_test", "Focus on the safety boundary", "user_alice");
    releaseFirst();
    const result = await running;

    assert.equal(result.status, "completed");
    assert.equal(result.text, "Revised around the safety boundary");
    assert.equal(calls, 2);
    assert.deepEqual(result.view.runs[result.runId].steering, [
      { message: "Focus on the safety boundary", actorId: "user_alice" },
    ]);
    const types = store.read("ses_turn_test").events.map((event) => event.type);
    assert.ok(types.indexOf("step.completed") < types.indexOf("steering.received"));
    assert.ok(types.indexOf("steering.received") < types.lastIndexOf("step.started"));
  });
});
