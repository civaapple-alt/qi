import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { parseTuiCliArguments } from "../apps/cli/dist/cli.js";
import {
  ACP_THOUGHT_MAX_CHARS,
  ACP_THOUGHT_REFRESH_MS,
  boundThoughtForAcp,
  contentBlocksToPromptText,
  createQiAcpAgent,
  createTestRuntimeFactory,
  cumulativeToDelta,
  inferToolKind,
  resolveAcpStreamPolicy,
  takeProgressiveThoughtSlice,
  turnStatusToStopReason,
} from "../apps/cli/dist/acp/index.js";

test("cumulativeToDelta only emits suffixes for cumulative activity text", () => {
  assert.deepEqual(cumulativeToDelta("", "Hello"), { delta: "Hello", next: "Hello" });
  assert.deepEqual(cumulativeToDelta("Hello", "Hello world"), { delta: " world", next: "Hello world" });
  assert.deepEqual(cumulativeToDelta("Hello world", "Hello world"), { delta: "", next: "Hello world" });
  // Restarted buffer
  assert.deepEqual(cumulativeToDelta("old", "new"), { delta: "new", next: "new" });
});

test("boundThoughtForAcp caps huge CoT so one notify cannot freeze VS Code", () => {
  const huge = "x".repeat(ACP_THOUGHT_MAX_CHARS + 5_000);
  const bounded = boundThoughtForAcp(huge);
  assert.ok(bounded.length < huge.length);
  assert.ok(bounded.length <= ACP_THOUGHT_MAX_CHARS + 120);
  assert.match(bounded, /truncated for IDE/i);
  assert.equal(boundThoughtForAcp("short"), "short");
});

test("takeProgressiveThoughtSlice prefers latest window when unsent is huge", () => {
  const unsent = "AAAA" + "B".repeat(ACP_THOUGHT_MAX_CHARS);
  const { emit, consumed } = takeProgressiveThoughtSlice(unsent, ACP_THOUGHT_MAX_CHARS);
  assert.equal(consumed, unsent.length);
  assert.ok(emit.length <= ACP_THOUGHT_MAX_CHARS + 5);
  assert.match(emit, /^…\nB+$/);
  const small = takeProgressiveThoughtSlice("hello", 100);
  assert.deepEqual(small, { emit: "hello", consumed: 5 });
});

test("ACP stream policy: thoughts=1 is progressive ~5s with size cap", () => {
  const defaults = resolveAcpStreamPolicy({});
  assert.equal(defaults.streamText, false);
  assert.equal(defaults.thoughts, "off");
  assert.equal(resolveAcpStreamPolicy({ QI_ACP_STREAM_TEXT: "1" }).streamText, true);
  const progressive = resolveAcpStreamPolicy({ QI_ACP_STREAM_THOUGHTS: "1" });
  assert.equal(progressive.thoughts, "progressive");
  assert.equal(progressive.coalesceMs, ACP_THOUGHT_REFRESH_MS);
  assert.equal(progressive.maxChunkChars, ACP_THOUGHT_MAX_CHARS);
  assert.equal(resolveAcpStreamPolicy({ QI_ACP_STREAM_THOUGHTS: "end" }).thoughts, "end");
  assert.equal(resolveAcpStreamPolicy({ QI_ACP_STREAM_THOUGHTS: "live" }).coalesceMs, 1500);
  assert.equal(resolveAcpStreamPolicy({ QI_ACP_COALESCE_MS: "3000" }).coalesceMs, 3000);
});

test("turnStatusToStopReason keeps outcomes distinct for clients", () => {
  assert.equal(turnStatusToStopReason("completed"), "end_turn");
  assert.equal(turnStatusToStopReason("cancelled"), "cancelled");
  assert.equal(turnStatusToStopReason("parked"), "refusal");
  assert.equal(turnStatusToStopReason("failed"), "refusal");
});

test("contentBlocksToPromptText joins text blocks", () => {
  assert.equal(
    contentBlocksToPromptText([
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ]),
    "Hello\nworld",
  );
  assert.equal(contentBlocksToPromptText([{ type: "image", data: "x", mimeType: "image/png" }]), "");
});

test("inferToolKind maps builtins", () => {
  assert.equal(inferToolKind("read"), "read");
  assert.equal(inferToolKind("edit"), "edit");
  assert.equal(inferToolKind("shell"), "execute");
  assert.equal(inferToolKind("fetch"), "fetch");
  assert.equal(inferToolKind("custom_mcp"), "other");
});

test("qi --help mentions acp", async () => {
  const help = await parseTuiCliArguments(["--help"], { environment: {}, packageVersion: "0.0.0" });
  assert.equal(help.kind, "help");
  assert.match(help.text, /qi acp/);
});

test("ACP in-process: initialize → authenticate → session/new → prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-acp-"));
  try {
    const model = new ScriptedModelPort([[
      { type: "text.delta", delta: "ACP hello" },
      { type: "completed", finishReason: "stop" },
    ]]);
    const workspace = join(root, "ws");
    const data = join(root, "data");
    const home = join(root, "home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    const parsed = await parseTuiCliArguments(
      ["--workspace", workspace, "--data", data, "--no-config", "--safe", "--mode", "ask"],
      {
        cwd: root,
        environment: { QI_HOME: home, OPENAI_API_KEY: "unused" },
      },
    );
    assert.equal(parsed.kind, "run");

    const handle = createQiAcpAgent({
      launch: parsed.options,
      factory: createTestRuntimeFactory(model),
      agentName: "Qi-test",
      agentVersion: "0.0.0-test",
    });

    try {
    await client({ name: "qi-acp-test-client" }).connectWith(handle.app, async (ctx) => {
      const init = await ctx.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "qi-acp-test-client", version: "0" },
      });
      assert.equal(init.protocolVersion, PROTOCOL_VERSION);
      assert.equal(init.agentInfo?.name, "Qi-test");
      assert.ok(init.authMethods?.some((method) => method.id === "qi_login"));

      await ctx.request("authenticate", { methodId: "qi_login" });

      const created = await ctx.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      assert.ok(created.sessionId);
      assert.match(created.sessionId, /^ses_/);
      assert.equal(created.modes?.currentModeId, "ask");
      assert.deepEqual(
        created.modes?.availableModes?.map((mode) => mode.id),
        ["ask", "plan", "agent"],
      );

      const promptResult = await ctx.request("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Say hello over ACP" }],
      });
      assert.equal(promptResult.stopReason, "end_turn");
      assert.equal(promptResult._meta?.qi?.status, "completed");
      assert.ok(promptResult._meta?.qi?.runId);
    });
    } finally {
      await handle.closeAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("ACP prompt streams agent_message_chunk text", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-acp-stream-"));
  try {
    const workspace = join(root, "ws");
    const data = join(root, "data");
    const home = join(root, "home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    const model = new ScriptedModelPort([[
      { type: "text.delta", delta: "Streamed " },
      { type: "text.delta", delta: "answer" },
      { type: "completed", finishReason: "stop" },
    ]]);
    const parsed = await parseTuiCliArguments(
      ["--workspace", workspace, "--data", data, "--no-config", "--safe"],
      {
        cwd: root,
        environment: { QI_HOME: home, OPENAI_API_KEY: "unused" },
      },
    );
    assert.equal(parsed.kind, "run");
    const handle = createQiAcpAgent({
      launch: parsed.options,
      factory: createTestRuntimeFactory(model),
    });

    try {
    await client({ name: "stream-client" }).connectWith(handle.app, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "stream-client", version: "0" },
      });
      await ctx.request("authenticate", { methodId: "qi_login" });

      const texts = [];
      await ctx.buildSession(workspace).withSession(async (session) => {
        const promptPromise = session.prompt("stream please");
        for (;;) {
          const msg = await session.nextUpdate();
          if (msg.kind === "session_update") {
            const update = msg.update;
            if (
              update.sessionUpdate === "agent_message_chunk"
              && update.content?.type === "text"
            ) {
              texts.push(update.content.text);
            }
          } else if (msg.kind === "stop") {
            assert.equal(msg.stopReason, "end_turn");
            break;
          }
        }
        await promptPromise;
      });
      const joined = texts.join("");
      assert.match(joined, /Streamed|answer|Streamed answer/);
    });
    } finally {
      await handle.closeAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
