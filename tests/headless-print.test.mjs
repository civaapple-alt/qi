import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { parseTuiCliArguments } from "../apps/cli/dist/cli.js";
import {
  exitCodeForTurnStatus,
  formatHeadlessJson,
  formatHeadlessText,
  formatStreamJsonLine,
  streamPartialFromActivity,
} from "../apps/cli/dist/headless.js";
import { TuiRuntime } from "../apps/cli/dist/runtime.js";

test("CLI -p requires a prompt and rejects format without print", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-print-parse-"));
  try {
    await assert.rejects(
      () => parseTuiCliArguments(["-p", "--no-config"], {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
      }),
      /requires a prompt/,
    );
    await assert.rejects(
      () => parseTuiCliArguments(["--output-format", "json", "--no-config"], {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
      }),
      /requires -p/,
    );
    await assert.rejects(
      () => parseTuiCliArguments(["-p", "hi", "--stream-partial-output", "--no-config"], {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
      }),
      /stream-json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI -p parses prompt, format, mode, and keeps workspace via --workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-print-opts-"));
  try {
    const workspace = join(root, "ws");
    await mkdir(workspace);
    const parsed = await parseTuiCliArguments(
      [
        "-p",
        "Summarize",
        "this",
        "--workspace",
        workspace,
        "--output-format",
        "json",
        "--mode",
        "ask",
        "--safe",
        "--no-config",
      ],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
      },
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.print, true);
    assert.equal(parsed.options.printPrompt, "Summarize this");
    assert.equal(parsed.options.outputFormat, "json");
    assert.equal(parsed.options.sessionMode, "ask");
    assert.equal(parsed.options.workspaceRoot, resolve(workspace));
    assert.equal(parsed.options.allowWrite, false);

    const short = await parseTuiCliArguments(
      ["--print", "--prompt", "Hello world", "--no-config"],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
      },
    );
    assert.equal(short.kind, "run");
    assert.equal(short.options.printPrompt, "Hello world");
    assert.equal(short.options.outputFormat, "text");
    assert.equal(short.options.workspaceRoot, resolve(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI help mentions print mode and marketplace subcommands", async () => {
  const help = await parseTuiCliArguments(["--help"], {
    environment: {},
    packageVersion: "0.0.0",
  });
  assert.equal(help.kind, "help");
  assert.match(help.text, /--print/);
  assert.match(help.text, /stream-json/);
  assert.match(help.text, /marketplace/);
  assert.match(help.text, /plugin/);
});

test("exit codes keep completed/parked/cancelled/failed distinct", () => {
  assert.equal(exitCodeForTurnStatus("completed"), 0);
  assert.equal(exitCodeForTurnStatus("failed"), 1);
  assert.equal(exitCodeForTurnStatus("parked"), 2);
  assert.equal(exitCodeForTurnStatus("cancelled"), 130);
});

test("headless formatters project TurnResult without TUI paint", () => {
  const result = {
    sessionId: "ses_test",
    runId: "run_test",
    status: "completed",
    text: "Hello from print mode",
    view: {},
  };
  assert.equal(formatHeadlessText(result), "Hello from print mode\n");
  assert.equal(formatHeadlessText({ ...result, text: "with\n" }), "with\n");

  const json = JSON.parse(formatHeadlessJson(result, {
    durationMs: 42,
    model: "m",
    provider: "p",
    mode: "ask",
  }));
  assert.equal(json.type, "result");
  assert.equal(json.subtype, "success");
  assert.equal(json.is_error, false);
  assert.equal(json.duration_ms, 42);
  assert.equal(json.result, "Hello from print mode");
  assert.equal(json.session_id, "ses_test");
  assert.equal(json.run_id, "run_test");
  assert.equal(json.status, "completed");
  assert.equal(json.mode, "ask");

  const failed = JSON.parse(formatHeadlessJson({ ...result, status: "parked", text: "" }, {
    durationMs: 1,
  }));
  assert.equal(failed.subtype, "parked");
  assert.equal(failed.is_error, true);

  const line = formatStreamJsonLine({ type: "system", subtype: "init" });
  assert.equal(line, '{"type":"system","subtype":"init"}\n');
});

test("stream partial activity maps model.text only", () => {
  assert.equal(
    streamPartialFromActivity({
      type: "model.reasoning",
      sessionId: "ses_1",
      runId: "run_1",
      stepId: "stp_1",
      text: "thinking",
      estimatedOutputTokens: 1,
      provisional: true,
    }),
    undefined,
  );
  const partial = streamPartialFromActivity({
    type: "model.text",
    sessionId: "ses_1",
    runId: "run_1",
    stepId: "stp_1",
    text: "Hi",
    estimatedOutputTokens: 1,
    provisional: true,
  });
  assert.equal(partial?.type, "assistant");
  assert.equal(partial?.session_id, "ses_1");
  assert.equal(partial?.message.content[0].text, "Hi");
  assert.equal(typeof partial?.timestamp_ms, "number");
});

test("print Run with ScriptedModelPort returns completed text (integration)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-print-run-"));
  let runtime;
  try {
    const model = new ScriptedModelPort([[
      { type: "text.delta", delta: "Printable answer" },
      { type: "completed", finishReason: "stop" },
    ]]);
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".data"),
      userSkillsRoot: join(root, "skills"),
      skillCompatibilityRoots: [],
      modelPort: model,
      model: { provider: "fake", model: "print-test" },
      interactiveQuestions: false,
    });
    runtime.changeMode("ask", "test");
    const result = await runtime.run("Say hello");
    assert.equal(result.status, "completed");
    assert.match(result.text, /Printable answer/);
    assert.equal(exitCodeForTurnStatus(result.status), 0);
    assert.equal(formatHeadlessText(result), "Printable answer\n");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("text-only model accepts standalone documentation URLs without image Internal error", async () => {
  // Mirrors ACP first-prompt failure: paste doc HTML links on their own lines.
  // ScriptedModelPort defaults include image; pin text-only like real non-vision models.
  const root = await mkdtemp(join(tmpdir(), "qi-print-doc-url-"));
  let runtime;
  try {
    const model = new ScriptedModelPort(
      [[
        { type: "text.delta", delta: "ok-docs" },
        { type: "completed", finishReason: "stop" },
      ]],
      {
        input: new Set(["text"]),
        output: new Set(["text", "reasoning", "action"]),
        contextTokens: 128_000,
        parallelActions: false,
        promptCache: false,
      },
    );
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".data"),
      userSkillsRoot: join(root, "skills"),
      skillCompatibilityRoots: [],
      modelPort: model,
      model: { provider: "fake", model: "text-only" },
      interactiveQuestions: false,
    });
    runtime.changeMode("ask", "test");
    const prompt = [
      "kimi3 目录下基于",
      "https://www.kimi.com/code/docs/kimi-code-cli/reference/kimi-acp.html",
      "https://www.kimi.com/code/docs/kimi-code-cli/guides/ides.html",
      "生成一个 kimi acp 的快速使用 html",
    ].join("\n");
    const result = await runtime.run(prompt);
    assert.equal(result.status, "completed");
    assert.match(result.text, /ok-docs/);
    assert.equal(model.requests.length, 1);
    // Prompt reaches the model as text (no forced image ingest).
    const userText = JSON.stringify(model.requests[0]);
    assert.match(userText, /kimi-acp\.html/);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("vision model keeps non-image standalone doc URLs as text when Network/MIME fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-print-doc-url-vision-"));
  let runtime;
  try {
    const model = new ScriptedModelPort([[
      { type: "text.delta", delta: "ok-as-text" },
      { type: "completed", finishReason: "stop" },
    ]]);
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".data"),
      userSkillsRoot: join(root, "skills"),
      skillCompatibilityRoots: [],
      modelPort: model,
      model: { provider: "fake", model: "vision-default" },
      allowNetwork: false,
      interactiveQuestions: false,
    });
    runtime.changeMode("ask", "test");
    const prompt = [
      "Based on",
      "https://www.kimi.com/code/docs/kimi-code-cli/guides/ides.html",
      "write a note",
    ].join("\n");
    const result = await runtime.run(prompt);
    assert.equal(result.status, "completed");
    assert.match(result.text, /ok-as-text/);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
