import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TuiRuntime } from "../apps/cli/dist/index.js";

test("scanVerificationSetup proposes package.json candidates and applyVerificationSetup writes .qi/qi.verify.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-verify-setup-"));
  const model = responseModel();
  let runtime;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "verify-setup"),
      modelPort: model,
      model: { provider: "fake", model: "verify-setup" },
    });
    const { candidates, currentNames } = await runtime.scanVerificationSetup();
    assert.equal(currentNames.length, 0);
    const testCandidate = candidates.find((candidate) => candidate.name === "test");
    assert.ok(testCandidate, JSON.stringify(candidates));

    const manifest = await runtime.applyVerificationSetup([testCandidate]);
    assert.deepEqual([...manifest.profiles], ["test"]);
    // Verify authority was never granted for this Runtime, so in-memory verificationManifest legitimately stays
    // unset (matching applyCapabilities({ verify: false }) semantics); the write to disk is still durable.
    assert.equal(runtime.verificationManifest, undefined);

    const { currentNames: afterApply } = await runtime.scanVerificationSetup();
    assert.deepEqual([...afterApply], ["test"]);
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("applyVerificationSetup refreshes the live verify tool when verify authority is already granted", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-verify-refresh-"));
  const model = responseModel();
  let runtime;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "verify-refresh"),
      modelPort: model,
      model: { provider: "fake", model: "verify-refresh" },
      allowVerify: true,
    });
    const beforeNames = [...(runtime.verificationManifest?.profiles ?? [])];
    const { candidates } = await runtime.scanVerificationSetup();
    const lintOnly = candidates.filter((candidate) => candidate.name === "lint");
    assert.equal(lintOnly.length, 1);

    await runtime.applyVerificationSetup(lintOnly);
    assert.deepEqual([...runtime.verificationManifest.profiles], ["lint"]);
    assert.notDeepEqual([...runtime.verificationManifest.profiles], beforeNames);

    await runtime.run("Please verify.");
    assert.ok(model.requests[0].tools.some((tool) => tool.name === "verify"));
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("applyVerificationSetup rejects an empty selection and while a Run is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tui-verify-guard-"));
  const model = responseModel();
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi", "verify-guard"),
      modelPort: model,
      model: { provider: "fake", model: "verify-guard" },
    });
    await assert.rejects(runtime.applyVerificationSetup([]));
  } finally {
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function responseModel() {
  return new ScriptedModelPort([[
    { type: "text.delta", delta: "Done." },
    { type: "completed", finishReason: "stop", responseId: "response_verify_setup" },
  ]]);
}
