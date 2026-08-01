import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesModelPort } from "@civaapple/qi-ai";
import { buildTuiContextBlocks } from "../apps/cli/dist/index.js";

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

function assembledQiBlocks() {
  return buildTuiContextBlocks({
    verificationProfiles: [],
    shellProfiles: {
      default: "direct",
      allowed: [],
      directEnabled: false,
      available: [],
      unavailable: [],
    },
    skills: [],
    capabilities: {
      write: false,
      verify: false,
      network: false,
      execute: false,
      background: false,
      delegate: false,
    },
    mode: "agent",
    platform: "linux",
  });
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

test("Responses preserves the assembled Qi block role and order", async () => {
  let captured;
  const client = {
    responses: {
      create(body) {
        captured = body;
        return asyncEvents([{
          type: "response.completed",
          sequence_number: 1,
          response: completedResponse(),
        }]);
      },
    },
  };
  const blocks = assembledQiBlocks();
  const port = new OpenAIResponsesModelPort(client);
  for await (const _event of port.stream(request({
    tools: [],
    messages: [
      ...blocks.map((block) => ({
        role: block.role,
        content: [{ type: "text", text: block.content }],
      })),
      { role: "user", content: [{ type: "text", text: "Explain status" }] },
    ],
  }))) {
    // Drain.
  }
  assert.deepEqual(
    captured.input.map((item) => item.role),
    [...blocks.map((block) => block.role), "user"],
  );
  assert.match(captured.input[0].content[0].text, /evidence-first/);
  assert.match(captured.input[1].content[0].text, /Session mode is Agent/);
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

test("Responses adapter keeps parallel function_call_output contiguous before tool media", async () => {
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
  const imageA = { type: "image", uri: "data:image/png;base64,aaa=", mediaType: "image/png" };
  const imageB = { type: "image", uri: "data:image/jpeg;base64,bbb=", mediaType: "image/jpeg" };
  const port = new OpenAIResponsesModelPort(client);
  for await (const _event of port.stream(request({
    tools: [],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool-call", callId: "read_image:0", name: "read_image", input: {} },
          { type: "tool-call", callId: "read_image:1", name: "read_image", input: {} },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          callId: "read_image:0",
          output: [{ type: "text", text: "a" }, imageA],
          isError: false,
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          callId: "read_image:1",
          output: [{ type: "text", text: "b" }, imageB],
          isError: false,
        }],
      },
    ],
  }))) {
    // Drain.
  }
  assert.deepEqual(
    captured.input.map((item) => item.type === "message" ? `message:${item.role}` : `${item.type}:${item.call_id ?? ""}`),
    [
      "function_call:read_image:0",
      "function_call:read_image:1",
      "function_call_output:read_image:0",
      "function_call_output:read_image:1",
      "message:user",
      "message:user",
    ],
  );
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

test("DeepSeek Responses sends reasoning effort, omits metadata, and echoes reasoning items", async () => {
  let captured;
  const client = {
    responses: {
      create(body) {
        captured = body;
        return asyncEvents([
          { type: "response.reasoning_text.delta", delta: "Plan", sequence_number: 1 },
          { type: "response.completed", sequence_number: 2, response: completedResponse() },
        ]);
      },
    },
  };
  const { getProviderProfile } = await import("@civaapple/qi-ai");
  const port = new OpenAIResponsesModelPort(client, {
    providerNames: ["deepseek"],
    requestMetadata: false,
    imageInput: false,
    reasoningEffort: "minimal",
    profile: getProviderProfile("deepseek"),
    contextTokens: 1_048_576,
  });
  const caps = await port.capabilities({ provider: "deepseek", model: "deepseek-v4-flash" });
  assert.equal(caps.contextTokens, 1_048_576);
  assert.equal(caps.input.has("image"), false);
  assert.equal(caps.promptCache, true);

  for await (const _event of port.stream(request({
    model: { provider: "deepseek", model: "deepseek-v4-flash" },
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "Use the tool" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I should call read_file" },
          { type: "tool-call", callId: "call_ds", name: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", callId: "call_ds", output: { text: "ok" }, isError: false },
        ],
      },
    ],
  }))) {
    // Drain.
  }

  assert.equal("metadata" in captured, false);
  assert.deepEqual(captured.reasoning, { effort: "low" });
  assert.equal(captured.input[1].type, "reasoning");
  assert.deepEqual(captured.input[1].content, [
    { type: "reasoning_text", text: "I should call read_file" },
  ]);
  assert.equal(captured.input[2].type, "function_call");
});

test("Volcengine Agent Plan Responses sends thinking.type, reasoning.effort, and max_output_tokens", async () => {
  let captured;
  const client = {
    responses: {
      create(body) {
        captured = body;
        return asyncEvents([
          { type: "response.reasoning_summary_text.delta", delta: "Plan", sequence_number: 1 },
          { type: "response.completed", sequence_number: 2, response: completedResponse() },
        ]);
      },
    },
  };
  const { getProviderProfile } = await import("@civaapple/qi-ai");
  const port = new OpenAIResponsesModelPort(client, {
    providerNames: ["volcengine-agent-plan"],
    requestMetadata: false,
    imageInput: true,
    reasoningEffort: "medium",
    profile: getProviderProfile("volcengine-agent-plan"),
    contextTokens: 1_048_576,
  });

  for await (const _event of port.stream(request({
    model: { provider: "volcengine-agent-plan", model: "glm-latest" },
    tools: [],
    maxOutputTokens: 1024,
  }))) {
    // Drain.
  }

  assert.equal("metadata" in captured, false);
  assert.deepEqual(captured.thinking, { type: "enabled" });
  assert.deepEqual(captured.reasoning, { effort: "medium" });
  assert.equal(captured.max_output_tokens, 1024);
});

test("Qianwen AI Token Plan sends reasoning.effort without thinking.type", async () => {
  const bodies = [];
  const client = {
    responses: {
      create(body) {
        bodies.push(body);
        return asyncEvents([
          { type: "response.reasoning_summary_text.delta", delta: "Plan", sequence_number: 1 },
          { type: "response.completed", sequence_number: 2, response: completedResponse() },
        ]);
      },
    },
  };
  const { getProviderProfile } = await import("@civaapple/qi-ai");
  const profile = getProviderProfile("qianwenai");
  const enabled = new OpenAIResponsesModelPort(client, {
    providerNames: ["qianwenai"],
    requestMetadata: false,
    imageInput: true,
    reasoningEffort: "medium",
    profile,
    contextTokens: 1_048_576,
  });
  for await (const _event of enabled.stream(request({
    model: { provider: "qianwenai", model: "qwen3.8-max-preview" },
    tools: [],
    maxOutputTokens: 2048,
  }))) {
    // Drain.
  }
  assert.equal("metadata" in bodies[0], false);
  assert.equal("thinking" in bodies[0], false);
  assert.deepEqual(bodies[0].reasoning, { effort: "medium" });
  assert.equal(bodies[0].max_output_tokens, 2048);

  const disabled = new OpenAIResponsesModelPort(client, {
    providerNames: ["qianwenai"],
    requestMetadata: false,
    reasoningEffort: "none",
    profile,
  });
  for await (const _event of disabled.stream(request({
    model: { provider: "qianwenai", model: "qwen3.7-plus" },
    tools: [],
  }))) {
    // Drain.
  }
  assert.equal("thinking" in bodies[1], false);
  assert.deepEqual(bodies[1].reasoning, { effort: "none" });
});

test("Volcengine Agent Plan disables thinking without reasoning.effort and omits thinking for non-thinking models", async () => {
  const bodies = [];
  const client = {
    responses: {
      create(body) {
        bodies.push(body);
        return asyncEvents([
          { type: "response.completed", sequence_number: 1, response: completedResponse() },
        ]);
      },
    },
  };
  const { getProviderProfile } = await import("@civaapple/qi-ai");
  const profile = getProviderProfile("volcengine-agent-plan");
  const disabled = new OpenAIResponsesModelPort(client, {
    providerNames: ["volcengine-agent-plan"],
    requestMetadata: false,
    reasoningEffort: "none",
    profile,
  });
  for await (const _event of disabled.stream(request({
    model: { provider: "volcengine-agent-plan", model: "glm-latest" },
    tools: [],
  }))) {
    // Drain.
  }
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal("reasoning" in bodies[0], false);

  const noThinking = new OpenAIResponsesModelPort(client, {
    providerNames: ["volcengine-agent-plan"],
    requestMetadata: false,
    reasoningEffort: "high",
    profile,
  });
  for await (const _event of noThinking.stream(request({
    model: { provider: "volcengine-agent-plan", model: "minimax-m2.7" },
    tools: [],
  }))) {
    // Drain.
  }
  assert.equal("thinking" in bodies[1], false);
  assert.equal("reasoning" in bodies[1], false);
});

test("DeepSeek Responses rejects image input", async () => {
  let called = false;
  const client = {
    responses: {
      create() {
        called = true;
        return asyncEvents([]);
      },
    },
  };
  const port = new OpenAIResponsesModelPort(client, {
    providerNames: ["deepseek"],
    imageInput: false,
  });
  await assert.rejects(async () => {
    for await (const _event of port.stream(request({
      model: { provider: "deepseek", model: "deepseek-v4-flash" },
      messages: [{
        role: "user",
        content: [{
          type: "image",
          uri: "data:image/png;base64,iVBORw0KGgo=",
          mediaType: "image/png",
        }],
      }],
    }))) {
      // Drain.
    }
  }, /does not accept image input/);
  assert.equal(called, false);
});
