import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIChatCompletionsModelPort,
  normalizeKimiReasoningEffort,
} from "@civaapple/qi-ai";
import { buildTuiContextBlocks } from "../apps/cli/dist/index.js";

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

test("Chat Completions preserves the assembled Qi block role and order", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body) {
          captured = body;
          return asyncEvents([{
            id: "chatcmpl_qi_context",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }]);
        },
      },
    },
  };
  const blocks = assembledQiBlocks();
  const port = new OpenAIChatCompletionsModelPort(client, { providerNames: ["kimi"] });
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
    captured.messages.map((message) => message.role),
    [...blocks.map((block) => block.role), "user"],
  );
  assert.match(captured.messages[0].content, /evidence-first/);
  assert.match(captured.messages[1].content, /Session mode is Agent/);
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

  assert.equal(captured.thinking, undefined);
  assert.equal(captured.reasoning_effort, "max");
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.delta",
    "text.delta",
    "completed",
  ]);
  assert.equal(events[0].delta, "Checking");
  assert.equal((await port.capabilities({ provider: "kimi", model: "k3" })).contextTokens, 1_048_576);
  assert.equal((await port.capabilities({ provider: "kimi", model: "k3-256k" })).contextTokens, 262_144);
});

test("Kimi thinking uses top-level reasoning_effort, disable for none, and keep:all for K2.7", async () => {
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
  const mediumOnK3 = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
    reasoningEffort: "medium",
  });
  for await (const _event of mediumOnK3.stream(request({
    model: { provider: "kimi", model: "k3" },
    tools: [],
  }))) {
    // drain
  }

  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.deepEqual(bodies[1].thinking, { type: "enabled", keep: "all" });
  assert.equal(bodies[1].reasoning_effort, undefined);
  assert.equal(bodies[2].thinking, undefined);
  assert.equal(bodies[2].reasoning_effort, "high");
  assert.equal(bodies[3].thinking, undefined);
  assert.equal(bodies[3].reasoning_effort, "low");
  // Catalog K3 omits medium; unsupported levels fall back to defaultEffort.
  assert.equal(bodies[4].thinking, undefined);
  assert.equal(bodies[4].reasoning_effort, "high");
  assert.equal(normalizeKimiReasoningEffort(undefined), undefined);
  assert.equal(normalizeKimiReasoningEffort(null), undefined);
  for (const value of ["ultra", "max", "xhigh"]) {
    assert.equal(normalizeKimiReasoningEffort(value), "max");
  }
  assert.equal(normalizeKimiReasoningEffort("high"), "high");
  assert.equal(normalizeKimiReasoningEffort("medium"), "medium");
  for (const value of ["low", "minimum", "light", "minimal"]) {
    assert.equal(normalizeKimiReasoningEffort(value), "low");
  }
  assert.equal(normalizeKimiReasoningEffort("none"), "none");
  assert.throws(() => normalizeKimiReasoningEffort("extreme"), /Unsupported reasoning effort/);

  const alwaysOff = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
    reasoningEffort: "none",
  });
  await assert.rejects(
    async () => {
      for await (const _event of alwaysOff.stream(request({ tools: [] }))) {
        // drain
      }
    },
    /keeps thinking always on/,
  );
});

test("Qianwen Token Plan Chat Completions sends enable_thinking for glm-5-2", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body) {
          captured = body;
          return asyncEvents([{
            id: "chatcmpl_qw",
            choices: [{
              index: 0,
              delta: { content: "ok" },
              finish_reason: "stop",
            }],
          }]);
        },
      },
    },
  };
  const { getProviderProfile } = await import("@civaapple/qi-ai");
  const port = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["qianwenai"],
    reasoningEffort: "medium",
    profile: getProviderProfile("qianwenai"),
  });
  for await (const _event of port.stream({
    requestId: "request-qianwenai-001",
    model: { provider: "qianwenai", model: "glm-5-2" },
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    // Drain.
  }
  assert.equal(captured.enable_thinking, true);
  assert.equal(captured.reasoning_effort, "medium");
  assert.equal("thinking" in captured, false);
});

test("DeepSeek Chat Completions sends thinking and echoes reasoning_content", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body) {
          captured = body;
          return asyncEvents([{
            id: "chatcmpl_ds",
            choices: [{
              index: 0,
              delta: { reasoning_content: "Think", content: "Answer" },
              finish_reason: "stop",
            }],
          }]);
        },
      },
    },
  };
  const port = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["deepseek"],
    reasoningEffort: "high",
  });
  const events = [];
  for await (const event of port.stream({
    requestId: "request-deepseek-001",
    model: { provider: "deepseek", model: "deepseek-v4-pro" },
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Need the weather tool" },
          { type: "tool-call", callId: "call_w", name: "get_weather", input: { city: "Hangzhou" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", callId: "call_w", output: "cloudy", isError: false },
        ],
      },
    ],
  })) events.push(event);

  assert.deepEqual(captured.thinking, { type: "enabled" });
  assert.equal(captured.reasoning_effort, "high");
  assert.equal(captured.messages[1].reasoning_content, "Need the weather tool");
  assert.equal(captured.messages[1].tool_calls[0].id, "call_w");
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning.delta",
    "text.delta",
    "completed",
  ]);
});

test("Chat Completions maps ordered image input and tool-result media", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body) {
          captured = body;
          return asyncEvents([{
            id: "chatcmpl_image",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          }]);
        },
      },
    },
  };
  const port = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
  });
  const image = { type: "image", uri: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" };
  for await (const _event of port.stream(request({
    model: { provider: "kimi", model: "k3" },
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", callId: "call_image", name: "read_image", input: {} }],
      },
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
  assert.deepEqual(captured.messages[0].content, [
    { type: "text", text: "before" },
    { type: "image_url", image_url: { url: image.uri } },
    { type: "text", text: "after" },
  ]);
  assert.equal(captured.messages[2].role, "tool");
  assert.deepEqual(JSON.parse(captured.messages[2].content).output, [{ type: "text", text: "crop" }]);
  assert.equal(captured.messages[3].role, "user");
  assert.equal(captured.messages[3].content[1].type, "image_url");
  assert.equal((await port.capabilities({ provider: "kimi", model: "k3" })).input.has("image"), true);
});

test("Chat Completions keeps parallel tool results contiguous before tool-result media", async () => {
  let captured;
  const client = {
    chat: {
      completions: {
        create(body) {
          captured = body;
          return asyncEvents([{
            id: "chatcmpl_parallel_image",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          }]);
        },
      },
    },
  };
  const port = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["kimi"],
  });
  const imageA = { type: "image", uri: "data:image/png;base64,aaa=", mediaType: "image/png" };
  const imageB = { type: "image", uri: "data:image/jpeg;base64,bbb=", mediaType: "image/jpeg" };
  for await (const _event of port.stream(request({
    model: { provider: "kimi", model: "k3" },
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect regions" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", callId: "read_image:0", name: "read_image", input: { region: { x: 0, y: 0, width: 10, height: 10 } } },
          { type: "tool-call", callId: "read_image:1", name: "read_image", input: { region: { x: 10, y: 10, width: 10, height: 10 } } },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          callId: "read_image:0",
          output: [{ type: "text", text: "crop a" }, imageA],
          isError: false,
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          callId: "read_image:1",
          output: [{ type: "text", text: "crop b" }, imageB],
          isError: false,
        }],
      },
    ],
  }))) {
    // Drain.
  }
  assert.deepEqual(
    captured.messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "user", "user"],
  );
  assert.equal(captured.messages[2].tool_call_id, "read_image:0");
  assert.equal(captured.messages[3].tool_call_id, "read_image:1");
  assert.match(captured.messages[4].content[0].text, /read_image:0/);
  assert.match(captured.messages[5].content[0].text, /read_image:1/);
});

test("compatible Chat Completions image input is deny-by-default with explicit opt-in", async () => {
  const client = { chat: { completions: { create() { throw new Error("not called"); } } } };
  const denied = new OpenAIChatCompletionsModelPort(client, { providerNames: ["compatible"] });
  const enabled = new OpenAIChatCompletionsModelPort(client, {
    providerNames: ["compatible"],
    imageInput: true,
  });
  assert.equal((await denied.capabilities({ provider: "compatible", model: "custom" })).input.has("image"), false);
  assert.equal((await enabled.capabilities({ provider: "compatible", model: "custom" })).input.has("image"), true);
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
