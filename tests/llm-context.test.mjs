import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextBudgetError,
  approximateTokenEstimator,
  compileContext,
  estimateSerializedTokens,
} from "@civaapple/qi-ai/context";
import { ScriptedModelPort } from "@civaapple/qi-ai";

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
  assert.deepEqual(compiled.blockStats, [
    {
      kind: "constitution",
      includedCount: 1,
      includedEstimatedTokens: 4,
      omittedCount: 0,
      omittedEstimatedTokens: 0,
    },
    {
      kind: "recent",
      includedCount: 0,
      includedEstimatedTokens: 0,
      omittedCount: 1,
      omittedEstimatedTokens: 4,
    },
    {
      kind: "goal",
      includedCount: 1,
      includedEstimatedTokens: 5,
      omittedCount: 0,
      omittedEstimatedTokens: 0,
    },
  ]);
  assert.deepEqual(compiled.messages.map((message) => message.role), ["system", "system"]);
});

test("Context Compiler pins optional blocks across a shrinking budget", () => {
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
      retentionReason: "Identity",
    },
    {
      id: "memory:context",
      kind: "memory",
      source: "memory",
      role: "user",
      content: "5",
      priority: 50,
      required: false,
      retentionReason: "Pinned memory",
    },
    {
      id: "skills:index",
      kind: "skill",
      source: "skills",
      role: "user",
      content: "3",
      priority: 40,
      required: false,
      retentionReason: "Optional skill index",
    },
  ];
  const first = compileContext({ blocks, budgetTokens: 12, estimator });
  assert.deepEqual(first.included.map((block) => block.id), [
    "constitution",
    "memory:context",
    "skills:index",
  ]);
  const second = compileContext({
    blocks,
    budgetTokens: 9,
    estimator,
    pinnedOptionalIds: ["memory:context"],
  });
  assert.deepEqual(second.included.map((block) => block.id), ["constitution", "memory:context"]);
  assert.deepEqual(second.omitted.map((block) => block.id), ["skills:index"]);
  assert.throws(
    () => compileContext({
      blocks,
      budgetTokens: 9,
      estimator,
      pinnedOptionalIds: ["memory:context", "skills:index"],
    }),
    (error) => error instanceof ContextBudgetError && error.requiredTokens === 12,
  );
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

test("fallback token estimation is conservative for CJK and accounts for framing", () => {
  assert.equal(approximateTokenEstimator.estimate("abcd"), 1);
  assert.equal(approximateTokenEstimator.estimate("中文"), 4);
  assert.ok(
    estimateSerializedTokens([{ role: "user", content: "中文" }], approximateTokenEstimator, 6)
      > approximateTokenEstimator.estimate("中文"),
  );
});

test("Context Compiler rejects invalid custom estimator results", () => {
  assert.throws(
    () => compileContext({
      blocks: [{
        id: "bad-estimate",
        kind: "recent",
        source: "test",
        role: "user",
        content: "content",
        priority: 1,
        required: false,
        retentionReason: "test",
      }],
      budgetTokens: 10,
      estimator: { estimate: () => Number.NaN },
    }),
    /invalid value/,
  );
});
