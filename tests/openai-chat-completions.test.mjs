import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIChatCompletionsModelPort,
  normalizeKimiReasoningEffort,
} from "@civaapple/qi-ai";

function asyncEvents(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function request(overrides = {}) {
  return {
    requestId: "request-chat-001",
    model: { provider: "kimi", model: "kimi-for-coding" },
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect it" }] }],
    tools: [
      {
        name: "read_file",
        description: "Read a UTF-8 file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens: 400,
    ...overrides,
  };
}

test("Chat Completions adapter streams text and releases tool calls only after finish", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body, options) {
          captured = { body, options };
          return asyncEvents([
            {
              id: "chatcmpl_1",
              choices: [{ index: 0, delta: { role: "assistant", content: "Reading" }, finish_reason: null }],
            },
            {
              id: "chatcmpl_1",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }],
                },
                finish_reason: null,
              }],
            },
            {
              id: "chatcmpl_1",
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] },
                finish_reason: null,
              }],
            },
            {
              id: "chatcmpl_1",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
            },
          ]);
        },
      },
    },
  };
  const port = new OpenAIChatCompletionsModelPort(client, { providerNames: ["kimi"] });
  const events = [];
  for await (const event of port.stream(request())) events.push(event);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.model, "kimi-for-coding");
  assert.equal(captured.body.max_completion_tokens, 400);
  assert.equal(captured.body.max_tokens, undefined);
  assert.deepEqual(events.map((event) => event.type), [
    "text.delta",
    "usage",
    "action.requested",
    "completed",
  ]);
  assert.equal(events[2].name, "read_file");
  assert.deepEqual(events[2].input, { path: "README.md" });
  assert.equal(events[3].finishReason, "actions");
});

test("Chat Completions adapter does not release incomplete tool arguments", async () => {
  const client = {
    chat: {
      completions: {
        create() {
          return asyncEvents([
            {
              id: "chatcmpl_2",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }],
                },
                finish_reason: null,
              }],
            },
            {
              id: "chatcmpl_2",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ]);
        },
      },
    },
  };
  const port = new OpenAIChatCompletionsModelPort(client, { providerNames: ["kimi"] });
  const events = [];
  for await (const event of port.stream(request())) events.push(event);
  assert.equal(events.at(-1)?.type, "failed");
  assert.equal(events.at(-1)?.code, "invalid_tool_arguments");
});

test("Kimi Chat Completions applies K3 thinking effort aliases and streams reasoning", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body) {
          captured = body;
          return asyncEvents([
            {
              id: "chatcmpl_k3",
              choices: [{
                index: 0,
                delta: { reasoning_content: "Checking", content: "Done" },
                finish_reason: "stop",
              }],
            },
          ]);
        },
      },
    },
  };
  const port = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
    reasoningEffort: "xhigh",
  });
  const events = [];
  for await (const event of port.stream(request({
    model: { provider: "kimi", model: "k3" },
    tools: [],
  }))) events.push(event);

  assert.deepEqual(captured.thinking, { type: "enabled", effort: "max" });
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.delta",
    "text.delta",
    "completed",
  ]);
  assert.equal(events[0].delta, "Checking");
  assert.equal((await port.capabilities({ provider: "kimi", model: "k3" })).contextTokens, 1_048_576);
  assert.equal((await port.capabilities({ provider: "kimi", model: "k3-256k" })).contextTokens, 262_144);
});

test("Kimi thinking uses explicit disable for none and boolean enable for K2.7 Code", async () => {
  const bodies = [];
  const client = {
    chat: {
      completions: {
        create(body) {
          bodies.push(body);
          return asyncEvents([{
            id: "chatcmpl_thinking",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          }]);
        },
      },
    },
  };
  const disabled = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
    reasoningEffort: "none",
  });
  for await (const _event of disabled.stream(request({
    model: { provider: "kimi", model: "k3" },
    tools: [],
  }))) {
    // drain
  }
  const k2 = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
    reasoningEffort: "max",
  });
  for await (const _event of k2.stream(request({ tools: [] }))) {
    // drain
  }
  const defaultK3 = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
  });
  for await (const _event of defaultK3.stream(request({
    model: { provider: "kimi", model: "k3" },
    tools: [],
  }))) {
    // drain
  }
  const customKimi = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
    reasoningEffort: "low",
  });
  for await (const _event of customKimi.stream(request({
    model: { provider: "kimi", model: "future-kimi" },
    tools: [],
  }))) {
    // drain
  }

  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.deepEqual(bodies[1].thinking, { type: "enabled" });
  assert.deepEqual(bodies[2].thinking, { type: "enabled", effort: "high" });
  assert.deepEqual(bodies[3].thinking, { type: "enabled", effort: "low" });
  assert.equal(normalizeKimiReasoningEffort(undefined), undefined);
  assert.equal(normalizeKimiReasoningEffort(null), undefined);
  for (const value of ["ultra", "max", "xhigh"]) {
    assert.equal(normalizeKimiReasoningEffort(value), "max");
  }
  for (const value of ["high", "medium"]) {
    assert.equal(normalizeKimiReasoningEffort(value), "high");
  }
  for (const value of ["low", "minimum", "light"]) {
    assert.equal(normalizeKimiReasoningEffort(value), "low");
  }
  assert.equal(normalizeKimiReasoningEffort("none"), "none");
  assert.throws(() => normalizeKimiReasoningEffort("extreme"), /Unsupported Kimi reasoning effort/);
});

test("normalizeFunctionParameters forces type object for TypeBox unions", async () => {
  const { normalizeFunctionParameters } = await import("@civaapple/qi-ai");
  const union = {
    anyOf: [
      { type: "object", properties: { operation: { const: "list", type: "string" } }, required: ["operation"] },
      { type: "object", properties: { operation: { const: "load", type: "string" } }, required: ["operation"] },
    ],
  };
  assert.equal(normalizeFunctionParameters(union).type, "object");
  assert.ok(Array.isArray(normalizeFunctionParameters(union).anyOf));
  assert.equal(normalizeFunctionParameters({ type: "object", properties: {} }).type, "object");
});
