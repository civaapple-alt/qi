import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesModelPort } from "@civaapple/qi-ai";

function asyncEvents(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function completedResponse(overrides = {}) {
  return {
    id: "resp_123",
    output: [],
    usage: {
      input_tokens: 21,
      output_tokens: 8,
      total_tokens: 29,
      input_tokens_details: { cached_tokens: 5, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    requestId: "request-openai-001",
    model: { provider: "openai", model: "test-model" },
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
    metadata: { sessionId: "ses_test" },
    ...overrides,
  };
}

test("OpenAI adapter maps portable history and completed tool calls without provider state", async () => {
  let captured;
  const controller = new AbortController();
  const client = {
    responses: {
      create(body, options) {
        captured = { body, options };
        return asyncEvents([
          { type: "response.reasoning_summary_text.delta", delta: "Checking", sequence_number: 1 },
          { type: "response.output_text.delta", delta: "I will read it.", sequence_number: 2 },
          {
            type: "response.completed",
            sequence_number: 3,
            response: completedResponse({
              output: [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              ],
            }),
          },
        ]);
      },
    },
  };
  const port = new OpenAIResponsesModelPort(client);
  const events = [];
  for await (const event of port.stream(
    request({
      messages: [
        { role: "system", content: [{ type: "text", text: "Be precise" }] },
        { role: "user", content: [{ type: "text", text: "Inspect it" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "First pass" },
            { type: "tool-call", callId: "old_call", name: "read_file", input: { path: "a.txt" } },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", callId: "old_call", output: { text: "hello" }, isError: false },
          ],
        },
      ],
    }),
    controller.signal,
  )) {
    events.push(event);
  }

  assert.equal(captured.body.model, "test-model");
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.max_output_tokens, 400);
  assert.deepEqual(captured.body.metadata, { sessionId: "ses_test" });
  assert.deepEqual(captured.body.tools, [
    {
      type: "function",
      name: "read_file",
      description: "Read a UTF-8 file",
      parameters: request().tools[0].inputSchema,
      strict: false,
    },
  ]);
  assert.deepEqual(captured.body.input.map((item) => item.type), [
    "message",
    "message",
    "message",
    "function_call",
    "function_call_output",
  ]);
  assert.deepEqual(captured.body.input[3], {
    type: "function_call",
    call_id: "old_call",
    name: "read_file",
    arguments: '{"path":"a.txt"}',
  });
  assert.deepEqual(JSON.parse(captured.body.input[4].output), {
    ok: true,
    output: { text: "hello" },
  });
  assert.equal(captured.options.signal, controller.signal);

  assert.deepEqual(events, [
    { type: "reasoning.delta", delta: "Checking" },
    { type: "text.delta", delta: "I will read it." },
    { type: "usage", inputTokens: 21, outputTokens: 8, cachedInputTokens: 5 },
    {
      type: "action.requested",
      callId: "call_1",
      name: "read_file",
      input: { path: "README.md" },
    },
    { type: "completed", finishReason: "actions", responseId: "resp_123" },
  ]);
});

test("OpenAI adapter does not release actions from an incomplete response", async () => {
  const client = {
    responses: {
      create() {
        return asyncEvents([
          {
            type: "response.incomplete",
            sequence_number: 1,
            response: completedResponse({
              output: [
                {
                  type: "function_call",
                  call_id: "partial_call",
                  name: "write_file",
                  arguments: '{"path":"unsafe"}',
                },
              ],
              incomplete_details: { reason: "max_output_tokens" },
            }),
          },
        ]);
      },
    },
  };
  const events = [];
  for await (const event of new OpenAIResponsesModelPort(client).stream(request())) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["usage", "completed"]);
  assert.equal(events[1].finishReason, "length");
});

test("Responses adapter can omit request metadata for compatible providers that reject it", async () => {
  let captured;
  const client = {
    responses: {
      create(body) {
        captured = body;
        return asyncEvents([
          { type: "response.completed", sequence_number: 1, response: completedResponse() },
        ]);
      },
    },
  };
  const port = new OpenAIResponsesModelPort(client, {
    providerNames: ["xai"],
    requestMetadata: false,
  });
  for await (const _event of port.stream(
    request({ model: { provider: "xai", model: "grok-test" } }),
  )) {
    // Drain.
  }
  assert.equal("metadata" in captured, false);
});

test("Responses adapter preserves image order and emits tool-result media as a user message", async () => {
  let captured;
  const client = {
    responses: {
      create(body) {
        captured = body;
        return asyncEvents([
          { type: "response.completed", sequence_number: 1, response: completedResponse() },
        ]);
      },
    },
  };
  const image = { type: "image", uri: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" };
  const port = new OpenAIResponsesModelPort(client);
  for await (const _event of port.stream(request({
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          callId: "call_image",
          output: [{ type: "text", text: "crop" }, image],
          isError: false,
        }],
      },
    ],
  }))) {
    // Drain.
  }
  assert.deepEqual(captured.input[0].content.map((part) => part.type), [
    "input_text",
    "input_image",
    "input_text",
  ]);
  assert.equal(captured.input[1].type, "function_call_output");
  assert.deepEqual(JSON.parse(captured.input[1].output).output, [{ type: "text", text: "crop" }]);
  assert.equal(captured.input[2].type, "message");
  assert.equal(captured.input[2].content[1].type, "input_image");
});

test("OpenAI adapter rejects unsupported portable inputs before network execution", async () => {
  let called = false;
  const client = {
    responses: {
      create() {
        called = true;
        return asyncEvents([]);
      },
    },
  };
  const port = new OpenAIResponsesModelPort(client);
  await assert.rejects(async () => {
    for await (const _event of port.stream(
      request({
        messages: [{ role: "user", content: [{ type: "artifact", ref: "art_sha256" }] }],
      }),
    )) {
      // Drain.
    }
  }, /must be resolved/);
  assert.equal(called, false);
});

test("OpenAI adapter reports API failure and validates provider ownership", async () => {
  const client = {
    responses: {
      create() {
        return asyncEvents([
          {
            type: "response.failed",
            sequence_number: 1,
            response: completedResponse({
              error: { code: "rate_limit_exceeded", message: "slow down" },
              usage: null,
            }),
          },
        ]);
      },
    },
  };
  const port = new OpenAIResponsesModelPort(client);
  const events = [];
  for await (const event of port.stream(request())) events.push(event);
  assert.deepEqual(events, [
    { type: "failed", code: "rate_limit_exceeded", message: "slow down", retryable: true },
  ]);
  await assert.rejects(async () => port.capabilities({ provider: "anthropic", model: "test" }), /does not serve/);
});
