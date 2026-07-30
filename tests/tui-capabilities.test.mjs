import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { loadProjectConfig, TuiRuntime } from "../apps/cli/dist/index.js";

test("TUI applyCapabilities enables write tools mid-session and persists project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-caps-write-"));
  const projectConfigPath = join(root, "project-config.toml");
  const model = responseModel();
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "data"),
      projectConfigPath,
      modelPort: model,
      model: { provider: "fake", model: "caps-write" },
    });
    await runtime.run("Inspect tools.");
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "edit"), false);
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "write"), false);
    assert.match(requestText(model.requests[0]), /Workspace Write permission is disabled/);
    assert.match(requestText(model.requests[0]), /\/permissions/);
    assert.match(requestText(model.requests[0]), /machine-private/);

    const applied = await runtime.applyCapabilities({ write: true });
    assert.deepEqual(applied.capabilities.write, true);
    assert.ok(applied.labels.includes("write"));

    await runtime.run("Edit a file.");
    assert.equal(model.requests[1].tools.some((tool) => tool.name === "edit"), true);
    assert.equal(model.requests[1].tools.some((tool) => tool.name === "write"), true);
    assert.match(requestText(model.requests[1]), /Workspace Write permission is enabled/);

    const loaded = await loadProjectConfig(projectConfigPath);
    assert.equal(loaded.config.capabilities?.write, true);
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI applyCapabilities can disable network mid-session", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-caps-network-"));
  const projectConfigPath = join(root, "project-config.toml");
  const model = responseModel();
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "data"),
      projectConfigPath,
      modelPort: model,
      model: { provider: "fake", model: "caps-network" },
      allowNetwork: true,
    });
    await runtime.run("Fetch something.");
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "fetch"), true);

    await runtime.applyCapabilities({ network: false });
    await runtime.run("Fetch again?");
    assert.equal(model.requests[1].tools.some((tool) => tool.name === "fetch"), false);

    const loaded = await loadProjectConfig(projectConfigPath);
    assert.equal(loaded.config.capabilities?.network, false);
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI applyCapabilities rejects changes while a Run is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-caps-active-"));
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "data"),
      modelPort: new ScriptedModelPort([[
        { type: "text.delta", delta: "Working…" },
        { type: "completed", finishReason: "stop", responseId: "response_active_caps" },
      ]]),
      model: { provider: "fake", model: "caps-active" },
    });
    const runPromise = runtime.run("Busy.");
    await assert.rejects(
      () => runtime.applyCapabilities({ write: true }, { persist: false }),
      /Cannot change capabilities while a Run is active/,
    );
    await runPromise;
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI model context follows model switches unless the user set an explicit window", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-model-window-"));
  let automatic;
  let explicit;
  try {
    automatic = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, "automatic"),
      modelPort: new ScriptedModelPort([]),
      model: { provider: "kimi", model: "k3" },
      contextWindowTokens: 1_048_576,
      contextWindowTokensOverride: false,
      outputReserveTokens: 16_000,
    });
    assert.deepEqual(automatic.syncModelContextWindow(262_144), {
      contextWindowTokens: 262_144,
      contextBudgetTokens: 246_144,
      outputReserveTokens: 16_000,
    });
    assert.deepEqual(automatic.configureContextWindow(300_000), {
      contextWindowTokens: 300_000,
      contextBudgetTokens: 284_000,
      outputReserveTokens: 16_000,
    });
    assert.deepEqual(automatic.syncModelContextWindow(1_048_576), {
      contextWindowTokens: 300_000,
      contextBudgetTokens: 284_000,
      outputReserveTokens: 16_000,
    });

    explicit = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, "explicit"),
      modelPort: new ScriptedModelPort([]),
      model: { provider: "kimi", model: "k3" },
      contextWindowTokens: 524_288,
      contextWindowTokensOverride: true,
      outputReserveTokens: 16_000,
    });
    assert.deepEqual(explicit.syncModelContextWindow(262_144), {
      contextWindowTokens: 524_288,
      contextBudgetTokens: 508_288,
      outputReserveTokens: 16_000,
    });
  } finally {
    if (automatic) await automatic.close();
    if (explicit) await explicit.close();
    await rm(root, { recursive: true, force: true });
  }
});

function responseModel() {
  return new ScriptedModelPort([[
    { type: "text.delta", delta: "Done." },
    { type: "completed", finishReason: "stop", responseId: "response_caps_catalog" },
  ], [
    { type: "text.delta", delta: "Done again." },
    { type: "completed", finishReason: "stop", responseId: "response_caps_catalog_2" },
  ]]);
}

function requestText(request) {
  return request.messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
