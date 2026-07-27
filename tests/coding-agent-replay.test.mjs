import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import { TuiRuntime } from "@civaapple/qi";

const execFileAsync = promisify(execFile);

const replays = [
  {
    name: "pricing logic and receipt formatting",
    query: "applyDiscount",
    sources: {
      "src/pricing.mjs": [
        "export function applyDiscount(cents, percent) {",
        "  return Math.round(cents - percent);",
        "}",
        "",
      ].join("\n"),
      "src/receipt.mjs": [
        'import { applyDiscount } from "./pricing.mjs";',
        "export function receiptTotal(cents, percent) {",
        "  return `$${applyDiscount(cents, percent)}`;",
        "}",
        "",
      ].join("\n"),
    },
    testPath: "test/receipt.test.mjs",
    testContent: [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { receiptTotal } from "../src/receipt.mjs";',
      'test("discounted receipt uses percentage math and currency formatting", () => {',
      '  assert.equal(receiptTotal(1500, 20), "$12.00");',
      "});",
      "",
    ].join("\n"),
    edits: [
      {
        path: "src/pricing.mjs",
        oldText: "Math.round(cents - percent)",
        newText: "Math.round(cents * (1 - percent / 100))",
      },
      {
        path: "src/receipt.mjs",
        oldText: "`$${applyDiscount(cents, percent)}`",
        newText: "`$${(applyDiscount(cents, percent) / 100).toFixed(2)}`",
      },
    ],
    expectedFiles: {
      "src/pricing.mjs": "return Math.round(cents * (1 - percent / 100));",
      "src/receipt.mjs": "(applyDiscount(cents, percent) / 100).toFixed(2)",
    },
  },
  {
    name: "domain error code and transport mapping",
    query: "UserMissingError",
    sources: {
      "src/user-error.mjs": [
        "export class UserMissingError extends Error {",
        "  constructor(id) {",
        "    super(`User ${id} was not found`);",
        '    this.code = "NOT_FOUND";',
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/user-service.mjs": [
        'import { UserMissingError } from "./user-error.mjs";',
        "export async function handleUserRequest(id, lookup) {",
        "  try {",
        "    return { status: 200, body: await lookup(id) };",
        "  } catch (error) {",
        "    if (!(error instanceof UserMissingError)) throw error;",
        "    return { status: 500, body: { code: error.code, message: error.message } };",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    testPath: "test/user-service.test.mjs",
    testContent: [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { UserMissingError } from "../src/user-error.mjs";',
      'import { handleUserRequest } from "../src/user-service.mjs";',
      'test("missing users preserve the domain code and map to 404", async () => {',
      '  const result = await handleUserRequest("u-7", async () => { throw new UserMissingError("u-7"); });',
      '  assert.deepEqual(result, { status: 404, body: { code: "USER_NOT_FOUND", message: "User u-7 was not found" } });',
      "});",
      "",
    ].join("\n"),
    edits: [
      {
        path: "src/user-error.mjs",
        oldText: 'this.code = "NOT_FOUND"',
        newText: 'this.code = "USER_NOT_FOUND"',
      },
      {
        path: "src/user-service.mjs",
        oldText: "return { status: 500, body: { code: error.code, message: error.message } }",
        newText: "return { status: 404, body: { code: error.code, message: error.message } }",
      },
    ],
    expectedFiles: {
      "src/user-error.mjs": 'this.code = "USER_NOT_FOUND"',
      "src/user-service.mjs": "return { status: 404",
    },
  },
];

for (const replay of replays) {
  test(`coding-agent replay repairs ${replay.name} with verification and Git evidence`, async () => {
    await runReplay(replay);
  });
}

async function runReplay(replay) {
  const root = await mkdtemp(join(tmpdir(), "qi-coding-replay-"));
  const dataRoot = join(root, ".qi");
  const committed = [];
  try {
    await writeWorkspaceFile(root, "AGENTS.md", `Run ${replay.testPath} after changing source files.\n`);
    await writeWorkspaceFile(root, ".gitignore", ".qi/\n");
    await writeWorkspaceFile(root, replay.testPath, replay.testContent);
    for (const [path, content] of Object.entries(replay.sources)) await writeWorkspaceFile(root, path, content);
    await writeWorkspaceFile(root, ".qi/qi.verify.json", JSON.stringify({
      version: 1,
      profiles: {
        focused: {
          description: `Run ${replay.testPath}`,
          command: process.execPath,
          args: ["--test", replay.testPath],
          timeoutMs: 10_000,
        },
      },
    }));
    await initializeGit(root);

    const sourcePaths = Object.keys(replay.sources);
    const model = new ScriptedModelPort([
      [
        {
          type: "action.requested",
          callId: "call_search_symbol",
          name: "search",
          input: { query: replay.query, path: "src", maxResults: 20 },
        },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const output = toolOutput(request, "call_search_symbol");
        assert.equal(output.truncated, false);
        for (const path of sourcePaths) assert.equal(output.matches.some((match) => match.path === path), true);
        return [
          ...sourcePaths.map((path, index) => ({
            type: "action.requested",
            callId: `call_read_${index}`,
            name: "read",
            input: { path },
          })),
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        const reads = sourcePaths.map((_, index) => toolOutput(request, `call_read_${index}`));
        return [
          ...replay.edits.map((edit, index) => ({
            type: "action.requested",
            callId: `call_edit_${index}`,
            name: "edit",
            input: { ...edit, expectedSha256: reads[sourcePaths.indexOf(edit.path)].sha256 },
          })),
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        for (let index = 0; index < replay.edits.length; index += 1) {
          const output = toolOutput(request, `call_edit_${index}`);
          assert.equal(output.replacements, 1);
          assert.equal(output.diffTruncated, false);
        }
        return [
          {
            type: "action.requested",
            callId: "call_verify_focused",
            name: "verify",
            input: { profile: "focused" },
          },
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        const output = toolOutput(request, "call_verify_focused");
        assert.equal(output.exitCode, 0);
        assert.equal(output.timedOut, false);
        assert.match(output.definitionSha256, /^[a-f0-9]{64}$/);
        return [
          {
            type: "action.requested",
            callId: "call_git_diff",
            name: "git",
            input: { operation: "diff" },
          },
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        const output = toolOutput(request, "call_git_diff");
        for (const edit of replay.edits) {
          assert.match(output.stdout, new RegExp(escapeRegex(edit.newText)));
        }
        return [
          { type: "text.delta", delta: `Repaired ${replay.name}; focused verification passed and Git diff contains both source changes.` },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot,
      modelPort: model,
      model: { provider: "fake", model: "coding-replay-v1" },
      allowWrite: true,
      allowVerify: true,
      onEvent: (event) => committed.push(event),
    });
    try {
      const result = await runtime.run(`Fix the ${replay.name} regression and prove the focused test passes.`);
      const failedActions = committed
        .filter((event) => event.type === "action.failed" || event.type === "action.indeterminate")
        .map((event) => ({ type: event.type, data: event.data }));
      const lastToolResults = model.requests.at(-1)?.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "tool-result")
        .map((part) => ({ callId: part.callId, output: part.output })) ?? [];
      assert.equal(result.status, "completed", JSON.stringify({ failedActions, lastToolResults, text: result.text }));
      assert.match(result.text, /focused verification passed/);
      assert.deepEqual(
        committed.filter((event) => event.type === "action.proposed").map((event) => event.data.toolName),
        ["search", "read", "read", "edit", "edit", "verify", "git"],
      );
      assert.equal(model.requests.every((request) => request.tools.every((tool) => tool.name !== "shell")), true);
      for (const [path, expected] of Object.entries(replay.expectedFiles)) {
        assert.match(await readFile(join(root, path), "utf8"), new RegExp(escapeRegex(expected)));
      }
    } finally {
      runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolOutput(request, callId) {
  const result = request.messages
    .flatMap((message) => message.content)
    .find((part) => part.type === "tool-result" && part.callId === callId);
  assert.ok(result, `Expected tool output for ${callId}`);
  return JSON.parse(result.output[0].text);
}

async function writeWorkspaceFile(root, path, content) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function initializeGit(root) {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "qi@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Qi Replay"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture baseline"], { cwd: root });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
