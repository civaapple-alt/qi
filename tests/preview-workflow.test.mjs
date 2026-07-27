import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("preview workflow runs the installable gate on every supported CI operating system", async () => {
  const source = await readFile(join(root, ".github", "workflows", "preview-acceptance.yml"), "utf8");
  const workflow = parse(source);
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(workflow.jobs["installable-preview"].strategy.matrix.os, [
    "ubuntu-latest",
    "windows-latest",
    "macos-latest",
  ]);

  const steps = workflow.jobs["installable-preview"].steps;
  const setup = steps.find((step) => step.uses === "actions/setup-node@v4");
  assert.equal(setup?.with?.["node-version"], "22.19.0");
  const acceptance = steps.find((step) => step.name === "Run installable-preview gate");
  assert.match(acceptance?.run ?? "", /scripts\/preview-acceptance\.mjs/);
  assert.match(acceptance?.run ?? "", /preview-acceptance\.json/);

  const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");
  assert.equal(upload?.if, "always()");
  assert.equal(upload?.with?.["if-no-files-found"], "error");
  assert.match(upload?.with?.path ?? "", /preview-acceptance\.json/);
});
