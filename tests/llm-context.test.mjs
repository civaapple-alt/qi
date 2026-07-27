import assert from "node:assert/strict";
import test from "node:test";
import { ContextBudgetError, compileContext } from "@civaapple/qi-context";
import { ScriptedModelPort } from "@civaapple/qi-llm";

const model = { provider: "fake", model: "deterministic-v1" };
const request = {
  requestId: "request-001",
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

test("ScriptedModelPort streams a deterministic response and records the request", async () => {
  const port = new ScriptedModelPort([
    [
      { type: "reasoning.delta", delta: "Inspecting constraints" },
      { type: "text.delta", delta: "Hello" },
      { type: "usage", inputTokens: 8, outputTokens: 2 },
      { type: "completed", finishReason: "stop", responseId: "response-001" },
    ],
  ]);
  const events = [];
  for await (const event of port.stream(request)) events.push(event);

  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.delta",
    "text.delta",
    "usage",
    "completed",
  ]);
  assert.deepEqual(port.requests, [request]);
});

test("ScriptedModelPort rejects scripts without exactly one terminal boundary", async () => {
  const missingTerminal = new ScriptedModelPort([[{ type: "text.delta", delta: "unfinished" }]]);
  await assert.rejects(async () => {
    for await (const _event of missingTerminal.stream(request)) {
      // Drain the stream to force terminal validation.
    }
  }, /must end with completed or failed/);

  const afterTerminal = new ScriptedModelPort([
    [
      { type: "completed", finishReason: "stop" },
      { type: "text.delta", delta: "too late" },
    ],
  ]);
  await assert.rejects(async () => {
    for await (const _event of afterTerminal.stream({ ...request, requestId: "request-002" })) {
      // Drain the stream to force ordering validation.
    }
  }, /cannot emit events after a terminal event/);
});

test("ScriptedModelPort honors cancellation before consuming a script", async () => {
  const port = new ScriptedModelPort([[{ type: "completed", finishReason: "stop" }]]);
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(async () => {
    for await (const _event of port.stream(request, controller.signal)) {
      // The stream must not start.
    }
  }, /cancelled by test/);
  assert.equal(port.requests.length, 0);
});

test("Context Compiler keeps required blocks and spends remaining budget by priority", () => {
  const estimator = { estimate: (text) => Number(text) };
  const blocks = [
    {
      id: "constitution",
      kind: "constitution",
      source: "agent.md",
      role: "system",
      content: "4",
      priority: 100,
      required: true,
      retentionReason: "Agent identity",
    },
    {
      id: "recent-low",
      kind: "recent",
      source: "session:1",
      role: "user",
      content: "4",
      priority: 10,
      required: false,
      retentionReason: "Recent context",
    },
    {
      id: "goal-high",
      kind: "goal",
      source: "goal:1",
      role: "system",
      content: "5",
      priority: 90,
      required: false,
      retentionReason: "Active goal",
    },
  ];

  const compiled = compileContext({ blocks, budgetTokens: 9, estimator });
  assert.deepEqual(compiled.included.map((block) => block.id), ["constitution", "goal-high"]);
  assert.deepEqual(compiled.omitted.map((block) => block.id), ["recent-low"]);
  assert.equal(compiled.estimatedTokens, 9);
  assert.deepEqual(compiled.messages.map((message) => message.role), ["system", "system"]);
});

test("Context Compiler fails closed when required context exceeds budget", () => {
  assert.throws(
    () =>
      compileContext({
        blocks: [
          {
            id: "control",
            kind: "control",
            source: "lease:1",
            role: "system",
            content: "required",
            priority: 100,
            required: true,
            retentionReason: "Authority boundary",
          },
        ],
        budgetTokens: 1,
        estimator: { estimate: () => 2 },
      }),
    (error) => error instanceof ContextBudgetError && error.requiredTokens === 2,
  );
});

test("Context Compiler is deterministic and rejects ambiguous duplicate IDs", () => {
  const block = {
    id: "same",
    kind: "recent",
    source: "session:1",
    role: "user",
    content: "hello",
    priority: 1,
    required: false,
    retentionReason: "test",
  };
  const first = compileContext({ blocks: [block], budgetTokens: 10 });
  const second = compileContext({ blocks: [structuredClone(block)], budgetTokens: 10 });
  assert.deepEqual(first, second);
  assert.throws(() => compileContext({ blocks: [block, block], budgetTokens: 10 }), /Duplicate context block id/);
});
