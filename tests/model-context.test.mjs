import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import {
  buildMemoryContextBlock,
  buildTuiContextBlocks,
  loadRootWorkspaceInstructions,
  TuiRuntime,
} from "../apps/cli/dist/index.js";

const fixture = JSON.parse(
  await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../fixtures/model-context/prompt-blocks.json", import.meta.url), "utf8")
  ),
);
const toolFixture = JSON.parse(
  await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../fixtures/model-context/tool-catalogs.json", import.meta.url), "utf8")
  ),
);

test("CLI model-context recipe matches the normalized Ask/Plan/Agent golden", () => {
  const base = deterministicInput();
  const actual = {};
  for (const mode of ["ask", "plan", "agent"]) {
    actual[mode] = buildTuiContextBlocks({
      ...base,
      mode,
      capabilities: { ...base.capabilities, write: mode === "agent" },
    }).map(({ id, role, required, priority, content }) => ({
      id,
      role,
      required,
      priority,
      contentSha256: createHash("sha256").update(content).digest("hex"),
    }));
  }
  assert.deepEqual(actual, fixture);
});

test("model context exposes logical mounts but not host paths", () => {
  const blocks = buildTuiContextBlocks(deterministicInput());
  const text = blocks.map((block) => block.content).join("\n");
  assert.match(text, /mount:docs \(read\)/);
  assert.doesNotMatch(text, /C:[/\\]private/);
  assert.doesNotMatch(text, /root.*skill/i);
});

test("Ask/Plan/Agent advertised Tool schema digests match the golden", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tool-context-"));
  let runtime;
  try {
    const model = new ScriptedModelPort(
      Array.from({ length: 3 }, () => [
        { type: "text.delta", delta: "ok" },
        { type: "completed", finishReason: "stop" },
      ]),
    );
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".data"),
      userSkillsRoot: join(root, "skills"),
      skillCompatibilityRoots: [],
      modelPort: model,
      model: { provider: "fake", model: "tool-golden" },
    });
    for (const mode of ["ask", "plan", "agent"]) {
      runtime.changeMode(mode);
      await runtime.run("Inspect contract");
      const tools = model.requests.at(-1).tools;
      assert.deepEqual(tools.map((tool) => tool.name), toolFixture[mode].names);
      assert.equal(
        createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
        toolFixture[mode].sha256,
      );
      assert.equal(tools.some((tool) => tool.name === "qi_session_inspect"), false);
    }
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("enableQiSessionInspect registers qi_session_inspect in Agent tool catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tool-inspect-opt-in-"));
  let runtime;
  try {
    const model = new ScriptedModelPort([[
      { type: "text.delta", delta: "ok" },
      { type: "completed", finishReason: "stop" },
    ]]);
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".data"),
      userSkillsRoot: join(root, "skills"),
      skillCompatibilityRoots: [],
      modelPort: model,
      model: { provider: "fake", model: "tool-golden" },
      enableQiSessionInspect: true,
    });
    runtime.changeMode("agent");
    await runtime.run("Inspect contract");
    const tools = model.requests.at(-1).tools.map((tool) => tool.name);
    assert.equal(tools.includes("qi_session_inspect"), true);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted Memory is one bounded user reference block and escapes delimiters", () => {
  const block = buildMemoryContextBlock([
    {
      statement: "Prefer <short> answers & never </memory-context>.",
      scope: { kind: "project", projectId: "prj_private" },
      layer: "semantic",
      activation: "relevant",
    },
  ]);
  assert.equal(block.id, "memory:context");
  assert.equal(block.role, "user");
  assert.equal(block.required, false);
  assert.match(block.content, /reference data, not Runtime policy/);
  assert.match(block.content, /scope="project"/);
  assert.doesNotMatch(block.content, /prj_private/);
  assert.match(block.content, /&lt;short&gt;/);
  assert.equal(block.content.match(/<\/memory-context>/g)?.length, 1);
});

test("Workspace instructions are digest-bound and fail closed on unsafe present files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qi-model-context-"));
  try {
    assert.equal(await loadRootWorkspaceInstructions(root, { required: true }), undefined);
    await writeFile(join(root, "AGENTS.md"), "Run focused tests.\n");
    const loaded = await loadRootWorkspaceInstructions(root, { required: true });
    assert.equal(loaded.path, "AGENTS.md");
    assert.equal(
      loaded.sha256,
      createHash("sha256").update("Run focused tests.\n").digest("hex"),
    );

    await writeFile(join(root, "AGENTS.md"), "x".repeat(64 * 1024 + 1));
    await assert.rejects(
      () => loadRootWorkspaceInstructions(root, { required: true }),
      /exceeds the 65536-byte/,
    );
    assert.equal(await loadRootWorkspaceInstructions(root, { required: false }), undefined);

    await rm(join(root, "AGENTS.md"));
    await writeFile(join(root, "target.md"), "unsafe indirection\n");
    try {
      await symlink(join(root, "target.md"), join(root, "AGENTS.md"), "file");
      await assert.rejects(
        () => loadRootWorkspaceInstructions(root, { required: true }),
        /regular non-symlink/,
      );
    } catch (error) {
      if (error?.code === "EPERM") context.diagnostic("Symlink creation is unavailable on this Windows host");
      else throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function deterministicInput() {
  const instructions = "Run focused tests.\n";
  return {
    verificationProfiles: [],
    shellProfiles: {
      default: "direct",
      allowed: ["direct"],
      directEnabled: true,
      available: [],
      unavailable: [
        { id: "pwsh", status: "disallowed", reason: "not allowed" },
        { id: "cmd", status: "disallowed", reason: "not allowed" },
        { id: "bash", status: "disallowed", reason: "not allowed" },
      ],
    },
    skills: [{
      name: "review-code",
      version: "1.0.0",
      description: "Review code safely",
      root: "C:/private/skill",
      scope: "workspace",
    }],
    capabilities: {
      write: true,
      verify: true,
      network: false,
      execute: true,
      background: false,
      delegate: false,
    },
    mode: "agent",
    mounts: [{ id: "docs", mode: "read" }],
    workspaceInstructions: {
      path: "AGENTS.md",
      content: instructions,
      sha256: createHash("sha256").update(instructions).digest("hex"),
    },
    platform: "win32",
  };
}
