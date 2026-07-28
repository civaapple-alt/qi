import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import { probeContainerRuntime } from "@civaapple/qi-codeact";
import { TuiRuntime } from "@civaapple/qi";

// The codeact tool is gated on a real container runtime responding to a probe, which varies by host. These tests
// probe independently first so the expectation always matches this machine's actual capability, rather than
// asserting a fixed docker/podman presence that would make the suite flaky across environments.

test("TUI advertises codeact under execute only when a container runtime actually responds", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-codeact-"));
  const model = responseModel();
  let runtime;
  try {
    const expectedRuntime = await probeContainerRuntime();
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "codeact-on"),
      modelPort: model,
      model: { provider: "fake", model: "codeact-on" },
      allowExecute: true,
    });
    await runtime.run("Hello.");
    const hasCodeact = model.requests[0].tools.some((tool) => tool.name === "codeact");
    assert.equal(hasCodeact, expectedRuntime !== undefined);
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI never advertises codeact without execute authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-codeact-off-"));
  const model = responseModel();
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "codeact-off"),
      modelPort: model,
      model: { provider: "fake", model: "codeact-off" },
    });
    await runtime.run("Hello.");
    assert.equal(model.requests[0].tools.some((tool) => tool.name === "codeact"), false);
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function responseModel() {
  return new ScriptedModelPort([[
    { type: "text.delta", delta: "Done." },
    { type: "completed", finishReason: "stop", responseId: "response_codeact_catalog" },
  ]]);
}
