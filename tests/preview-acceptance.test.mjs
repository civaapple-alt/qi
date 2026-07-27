import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("preview acceptance emits machine-readable failure evidence and cleans temporary state", async () => {
  const missingTarball = join(".cli-package", `missing-${process.pid}-${Date.now()}.tgz`);
  const result = await run(process.execPath, [
    "scripts/preview-acceptance.mjs",
    "--tarball",
    missingTarball,
  ]);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "qi.preview.acceptance");
  assert.equal(report.status, "fail");
  assert.equal(report.temporaryState.retained, false);
  assert.equal(report.checks.at(-1)?.id, "cleanup");
  assert.equal(report.checks.at(-1)?.status, "pass");
  assert.match(report.error, /missing-/);
});

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}
