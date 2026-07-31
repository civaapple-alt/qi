import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { SqliteEventStore } from "@civaapple/qi-node/storage";
import { projectPaths, projectSessionPaths } from "@civaapple/qi-node/paths";
import { renderEvent, renderStatus, TuiRuntime } from "../apps/cli/dist/index.js";

test("Memory persists across Sessions and only explicit User Memory crosses projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-memory-scope-"));
  const qiHome = join(root, "home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: projectA,
      dataRoot: join(projectA, ".qi"),
      qiHome,
      projectId: "project-a",
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "memory-v1" },
    });
    const projectClaim = runtime.rememberMemory("Project A uses pnpm.", "project");
    const userClaim = runtime.rememberMemory("The user prefers concise status.", "user", "always");
    assert.equal(projectClaim.scope.kind, "project");
    assert.equal(userClaim.scope.kind, "user");
    assert.equal(userClaim.activation, "always");
    await runtime.close();
    runtime = undefined;

    runtime = await TuiRuntime.create({
      workspaceRoot: projectA,
      dataRoot: join(projectA, ".qi"),
      qiHome,
      projectId: "project-a",
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "memory-v1" },
    });
    assert.deepEqual(
      runtime.listMemories({ statuses: ["accepted"] }).map((claim) => claim.statement).sort(),
      ["Project A uses pnpm.", "The user prefers concise status."],
    );
    await runtime.close();
    runtime = undefined;

    runtime = await TuiRuntime.create({
      workspaceRoot: projectB,
      dataRoot: join(projectB, ".qi"),
      qiHome,
      projectId: "project-b",
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "memory-v1" },
    });
    const crossProject = runtime.listMemories({ statuses: ["accepted"] });
    assert.deepEqual(crossProject.map((claim) => claim.statement), ["The user prefers concise status."]);
    assert.equal(crossProject[0].scope.kind, "user");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled Memory remains manageable but is not injected, and secrets never enter Session events", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-memory-disabled-"));
  let runtime;
  const model = new ScriptedModelPort([
    (request) => {
      const prompt = request.messages.flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.doesNotMatch(prompt, /Remembered while disabled/);
      assert.equal(request.tools.some((tool) => tool.name === "memory"), false);
      return [
        { type: "text.delta", delta: "Memory injection is disabled." },
        { type: "completed", finishReason: "stop" },
      ];
    },
  ]);
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      qiHome: join(root, "home"),
      projectId: "disabled-project",
      memoryEnabled: false,
      modelPort: model,
      model: { provider: "fake", model: "memory-disabled-v1" },
    });
    const claim = runtime.rememberMemory("Remembered while disabled.", "project");
    assert.equal(runtime.listMemories().some((candidate) => candidate.memoryId === claim.memoryId), true);
    assert.throws(
      () => runtime.rememberMemory("API token sk-1234567890abcdefghijklmnop", "project"),
      /was not recorded/i,
    );
    assert.equal(
      runtime.events().some((event) =>
        JSON.stringify(event.data).includes("sk-1234567890abcdefghijklmnop")),
      false,
    );
    const result = await runtime.run("Report whether Memory is injected.");
    assert.equal(result.status, "completed");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory tool auto-accepts exact public project evidence and injects it on the next Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-memory-tool-"));
  let runtime;
  const model = new ScriptedModelPort([
    (request) => {
      assert.equal(request.tools.some((tool) => tool.name === "memory"), true);
      return [
        {
          type: "action.requested",
          callId: "call_memory_project",
          name: "memory",
          input: {
            statement: "This repository uses pnpm.",
            layer: "semantic",
            scope: "project",
            sensitivity: "public",
            confidence: 0.95,
            source: { kind: "user_input", evidenceQuote: "repository uses pnpm" },
          },
        },
        {
          type: "action.requested",
          callId: "call_memory_user",
          name: "memory",
          input: {
            statement: "The user prefers concise status.",
            layer: "semantic",
            scope: "user",
            sensitivity: "private",
            confidence: 0.99,
            source: { kind: "user_input", evidenceQuote: "Remember that" },
          },
        },
        { type: "completed", finishReason: "actions" },
      ];
    },
    (request) => {
      const result = request.messages.flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_memory_project");
      assert.ok(result);
      assert.equal(JSON.parse(result.output[0].text).status, "accepted");
      const pending = request.messages.flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_memory_user");
      assert.ok(pending);
      assert.equal(JSON.parse(pending.output[0].text).status, "candidate");
      return [
        { type: "text.delta", delta: "Saved the project Memory." },
        { type: "completed", finishReason: "stop" },
      ];
    },
    (request) => {
      const prompt = request.messages.flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(prompt, /This repository uses pnpm\./);
      return [
        { type: "text.delta", delta: "The project uses pnpm." },
        { type: "completed", finishReason: "stop" },
      ];
    },
  ]);
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      qiHome: join(root, "home"),
      projectId: "memory-tool-project",
      modelPort: model,
      model: { provider: "fake", model: "memory-tool-v1" },
    });
    assert.equal((await runtime.run("This repository uses pnpm. Remember that.")).status, "completed");
    const claim = runtime.listMemories({ statuses: ["accepted"] })[0];
    assert.equal(claim.statement, "This repository uses pnpm.");
    assert.equal(runtime.pendingMemoryCountForLatestRun(), 1);
    const pending = runtime.listMemories({ statuses: ["candidate"] })[0];
    assert.equal(pending.scope.kind, "user");
    runtime.acceptMemory(pending.memoryId);
    assert.equal((await runtime.run("Which package manager does this project use?")).status, "completed");
    const compiled = runtime.events().filter((event) => event.type === "context.compiled").at(-1);
    assert.equal(compiled.data.includedBlockIds.includes("memory:context"), true);
    const memoryMessage = model.requests.at(-1).messages.find((message) =>
      message.content.some((part) => part.type === "text" && part.text.includes("<memory-context>"))
    );
    assert.equal(memoryMessage?.role, "user");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI declared verification generates a private manifest from package scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-generated-verify-"));
  const dataRoot = join(root, ".qi");
  let runtime;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      packageManager: "npm@11",
      scripts: { test: "node --test", typecheck: "tsc --noEmit", dev: "node server.js" },
    }));
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot,
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "generated-verify-v1" },
      allowVerify: true,
    });
    assert.deepEqual(runtime.verificationManifest, {
      path: ".qi/qi.verify.json",
      origin: "generated",
      profiles: ["test", "typecheck"],
    });
    const generated = JSON.parse(await readFile(join(dataRoot, "qi.verify.json"), "utf8"));
    assert.deepEqual(Object.keys(generated.profiles).sort(), ["test", "typecheck"]);
    assert.deepEqual(generated.profiles.test.args, ["run", "test"]);
  } finally {
    runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI discloses Skill metadata first and loads instructions only through the Skill tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-skill-load-"));
  const dataRoot = join(root, ".qi");
  const skillRoot = join(dataRoot, "skills", "review-code");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review-code\ndescription: Review code for concrete defects\n---\nPRIVATE_REVIEW_WORKFLOW\n",
  );
  await writeFile(join(skillRoot, "references", "checklist.md"), "Check boundaries.\n");
  const model = new ScriptedModelPort([
    (request) => {
      const prompt = request.messages.flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(prompt, /<available-skill name="review-code" version="unversioned" scope="workspace">/);
      assert.match(prompt, /Review code for concrete defects/);
      assert.doesNotMatch(prompt, /PRIVATE_REVIEW_WORKFLOW/);
      assert.equal(request.tools.some((tool) => tool.name === "skill"), true);
      return [
        { type: "action.requested", callId: "call_load_skill", name: "skill", input: { operation: "load", name: "review-code" } },
        { type: "completed", finishReason: "actions" },
      ];
    },
    (request) => {
      const result = request.messages.flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_load_skill");
      assert.ok(result);
      const loaded = JSON.parse(result.output[0].text);
      assert.match(loaded.instructions, /PRIVATE_REVIEW_WORKFLOW/);
      assert.deepEqual(loaded.resources, ["references/checklist.md"]);
      return [
        { type: "text.delta", delta: "Loaded the relevant review Skill progressively." },
        { type: "completed", finishReason: "stop" },
      ];
    },
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot,
    userSkillsRoot: join(root, "user-skills"),
    skillCompatibilityRoots: [],
    modelPort: model,
    model: { provider: "fake", model: "skill-load-v1" },
  });
  try {
    const result = await runtime.run("Review this project using any relevant installed Skill.");
    assert.equal(result.status, "completed");
    assert.deepEqual(runtime.skillCatalog().map(({ name, scope }) => ({ name, scope })), [
      { name: "review-code", scope: "workspace" },
    ]);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI Skill tool installs a named compatible Skill into the Workspace under write authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-skill-install-"));
  const dataRoot = join(root, ".qi");
  const compatibility = join(root, "compatibility");
  const source = join(compatibility, ".system", "skill-creator");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: skill-creator\ndescription: Create effective Skills\n---\nCreate and validate a draft.\n",
  );
  const model = new ScriptedModelPort([
    [
      { type: "action.requested", callId: "call_install_skill", name: "skill", input: {
        operation: "install-workspace",
        name: "skill-creator",
        source: "skill-creator",
      } },
      { type: "completed", finishReason: "actions" },
    ],
    (request) => {
      const result = request.messages.flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_install_skill");
      assert.ok(result);
      assert.equal(JSON.parse(result.output[0].text).installed, true);
      return [
        { type: "text.delta", delta: "Installed skill-creator into this Workspace." },
        { type: "completed", finishReason: "stop" },
      ];
    },
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot,
    userSkillsRoot: join(root, "user-skills"),
    skillCompatibilityRoots: [compatibility],
    modelPort: model,
    model: { provider: "fake", model: "skill-install-v1" },
    allowWrite: true,
  });
  try {
    const result = await runtime.run("Install skill-creator for this Workspace.");
    assert.equal(result.status, "completed");
    assert.match(await readFile(join(dataRoot, "skills", "skill-creator", "SKILL.md"), "utf8"), /Create effective Skills/);
    assert.deepEqual(
      runtime.events().filter((event) => event.type === "action.proposed").map((event) => event.data.toolName),
      ["skill"],
    );
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("basic TUI completes a code task with durable action and diff evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-e2e-"));
  const dataRoot = join(root, ".qi");
  const committed = [];
  const model = new ScriptedModelPort([
    [
      {
        type: "action.requested",
        callId: "call_write",
        name: "write",
        input: {
          path: "greeting.ts",
          content: 'export const greeting = "hello";\n',
          expectedSha256: null,
        },
      },
      { type: "completed", finishReason: "actions", responseId: "response_write" },
    ],
    [
      {
        type: "action.requested",
        callId: "call_read",
        name: "read",
        input: { path: "greeting.ts" },
      },
      { type: "completed", finishReason: "actions", responseId: "response_read" },
    ],
    [
      { type: "text.delta", delta: "Created greeting.ts and verified its persisted content." },
      { type: "usage", inputTokens: 100, outputTokens: 12 },
      { type: "completed", finishReason: "stop", responseId: "response_final" },
    ],
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot,
    modelPort: model,
    model: { provider: "fake", model: "code-task-v1" },
    allowWrite: true,
    onEvent: (event) => committed.push(event),
  });
  const sessionId = runtime.sessionId;

  try {
    const result = await runtime.run("Create greeting.ts, then read it back before claiming success.");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Created greeting.ts and verified its persisted content.");
    assert.equal(await readFile(join(root, "greeting.ts"), "utf8"), 'export const greeting = "hello";\n');
    assert.match(renderStatus(result.view), /responded/);

    const proposed = committed.filter((event) => event.type === "action.proposed");
    const settled = committed.filter((event) => event.type === "action.completed");
    assert.equal(proposed.length, 2);
    assert.equal(settled.length, 2);
    assert.deepEqual(proposed.map((event) => event.data.toolName), ["write", "read"]);
    assert.ok(committed.every((event, index) => event.sequence === index + 1));
    assert.match(renderEvent(proposed[0]), /write/);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "list"), true);

    const writeCompletion = settled[0];
    const writeEvidence = JSON.parse(writeCompletion.data.modelOutput[0].text);
    assert.equal(writeEvidence.path, "greeting.ts");
    assert.equal(writeEvidence.created, true);
    assert.equal(writeEvidence.previousSha256, null);
    assert.match(writeEvidence.diff, /--- \/dev\/null/);
    assert.match(writeEvidence.diff, /\+export const greeting = "hello";/);
    assert.equal(writeEvidence.diffTruncated, false);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "git"), true);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "find"), true);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "tree"), true);
  } finally {
    runtime.close();
  }

  const reopened = new SqliteEventStore(
    projectSessionPaths(projectPaths({ workspaceRoot: root, dataRoot }), sessionId).databaseFile,
  );
  try {
    const recovered = reopened.load(sessionId);
    assert.equal(recovered.currentRunId, recovered.runOrder[0]);
    assert.equal(recovered.runs[recovered.currentRunId].status, "completed");
    assert.equal(reopened.read(sessionId).events.length, committed.length);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI repairs existing code under AGENTS instructions and verifies it with a real test process", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-coding-agent-"));
  const dataRoot = join(root, ".qi");
  await writeFile(join(root, "AGENTS.md"), "Run calculator.test.mjs after modifying calculator.mjs.\n");
  await mkdir(dataRoot);
  await writeFile(join(dataRoot, "qi.verify.json"), JSON.stringify({
    version: 1,
    profiles: {
      calculator: {
        description: "Run the calculator regression test",
        command: process.execPath,
        args: ["--test", "calculator.test.mjs"],
        timeoutMs: 10_000,
      },
    },
  }));
  await writeFile(join(root, "calculator.mjs"), "export const add = (left, right) => left - right;\n");
  await writeFile(
    join(root, "calculator.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "./calculator.mjs";',
      'test("add", () => assert.equal(add(2, 3), 5));',
      "",
    ].join("\n"),
  );
  const committed = [];
  const model = new ScriptedModelPort([
    (request) => {
      assert.equal(
        request.messages.some((message) => message.content.some(
          (part) => part.type === "text" && part.text.includes("Run calculator.test.mjs"),
        )),
        true,
      );
      return [
        { type: "action.requested", callId: "call_read_bug", name: "read", input: { path: "calculator.mjs" } },
        { type: "completed", finishReason: "actions" },
      ];
    },
    (request) => {
      const result = request.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_read_bug");
      assert.ok(result);
      const output = JSON.parse(result.output[0].text);
      assert.match(output.content, /left - right/);
      return [
        {
          type: "action.requested",
          callId: "call_edit_bug",
          name: "edit",
          input: {
            path: "calculator.mjs",
            oldText: "left - right",
            newText: "left + right",
            expectedSha256: output.sha256,
          },
        },
        { type: "completed", finishReason: "actions" },
      ];
    },
    (request) => {
      const result = request.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_edit_bug");
      assert.ok(result);
      const output = JSON.parse(result.output[0].text);
      assert.match(output.diff, /-export const add = \(left, right\) => left - right/);
      return [
        {
          type: "action.requested",
          callId: "call_test_fix",
          name: "verify",
          input: {
            profile: "calculator",
          },
        },
        { type: "completed", finishReason: "actions" },
      ];
    },
    (request) => {
      const result = request.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.callId === "call_test_fix");
      assert.ok(result);
      const output = JSON.parse(result.output[0].text);
      assert.equal(output.exitCode, 0);
      assert.equal(output.timedOut, false);
      return [
        { type: "text.delta", delta: "Fixed calculator.mjs and verified calculator.test.mjs passes." },
        { type: "completed", finishReason: "stop" },
      ];
    },
  ]);
  const runtime = await TuiRuntime.create({
    workspaceRoot: root,
    dataRoot,
    modelPort: model,
    model: { provider: "fake", model: "coding-agent-v1" },
    allowWrite: true,
    allowVerify: true,
    onEvent: (event) => committed.push(event),
  });

  try {
    assert.deepEqual(runtime.verificationManifest, {
      path: ".qi/qi.verify.json",
      origin: "existing",
      profiles: ["calculator"],
    });
    const result = await runtime.run("Fix the calculator bug and run the required test.");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Fixed calculator.mjs and verified calculator.test.mjs passes.");
    assert.equal(await readFile(join(root, "calculator.mjs"), "utf8"), "export const add = (left, right) => left + right;\n");
    assert.deepEqual(
      committed.filter((event) => event.type === "action.proposed").map((event) => event.data.toolName),
      ["read", "edit", "verify"],
    );
    const compiled = committed.find((event) => event.type === "context.compiled");
    assert.ok(compiled.data.includedBlockIds.includes("workspace:AGENTS.md"));
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "edit"), true);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "verify"), true);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "shell"), false);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
