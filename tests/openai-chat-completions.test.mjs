import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIChatCompletionsModelPort } from "@civaapple/qi-llm";

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

test("normalizeFunctionParameters forces type object for TypeBox unions", async () => {
  const { normalizeFunctionParameters } = await import("@civaapple/qi-llm");
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
