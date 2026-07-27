import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import { TuiRuntime } from "@civaapple/qi";

test("TUI advertises fetch only when network access is explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-network-"));
  const withoutNetworkModel = responseModel();
  const withNetworkModel = responseModel();
  let withoutNetwork;
  let withNetwork;
  try {
    withoutNetwork = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "without-network"),
      modelPort: withoutNetworkModel,
      model: { provider: "fake", model: "network-off" },
    });
    await withoutNetwork.run("Can you fetch a website?");
    assert.equal(withoutNetworkModel.requests[0].tools.some((tool) => tool.name === "fetch"), false);
    await withoutNetwork.close();
    withoutNetwork = undefined;

    withNetwork = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "with-network"),
      modelPort: withNetworkModel,
      model: { provider: "fake", model: "network-on" },
      allowNetwork: true,
    });
    await withNetwork.run("Fetch https://example.com/");
    assert.equal(withNetworkModel.requests[0].tools.some((tool) => tool.name === "fetch"), true);
  } finally {
    if (withoutNetwork) await withoutNetwork.close();
    if (withNetwork) await withNetwork.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI advertises ProcessTasks only under the separate background capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-background-"));
  const disabledModel = responseModel();
  const enabledModel = responseModel();
  const runtimes = [];
  try {
    const disabled = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "background-off"),
      modelPort: disabledModel,
      model: { provider: "fake", model: "background-off" },
      allowExecute: true,
    });
    runtimes.push(disabled);
    await disabled.run("Start a server.");
    assert.equal(disabledModel.requests[0].tools.some((tool) => tool.name === "shell"), true);
    assert.equal(disabledModel.requests[0].tools.some((tool) => tool.name === "task"), false);

    const enabled = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "background-on"),
      modelPort: enabledModel,
      model: { provider: "fake", model: "background-on" },
      allowBackground: true,
    });
    runtimes.push(enabled);
    await enabled.run("Start a server.");
    assert.equal(enabledModel.requests[0].tools.some((tool) => tool.name === "task"), true);
    assert.equal(enabledModel.requests[0].tools.some((tool) => tool.name === "shell"), false);
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await rm(root, { recursive: true, force: true });
  }
});

function responseModel() {
  return new ScriptedModelPort([[
    { type: "text.delta", delta: "Done." },
    { type: "completed", finishReason: "stop", responseId: "response_network_catalog" },
  ]]);
}
