import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createPackageReleasePlan,
  topologicalBatches,
} from "../scripts/lib/package-release.mjs";

const root = process.cwd();
const execFileAsync = promisify(execFile);

test("package release plan derives a coordinated, acyclic, core-first graph from manifests", async () => {
  const plan = await createPackageReleasePlan(root);
  assert.equal(plan.graphReady, true);
  assert.equal(plan.release, "0.5.1");
  assert.equal(plan.packages.length, 21);
  assert.equal(plan.waves.core.length, 11);
  assert.equal(plan.waves.extension.length, 10);
  assert.equal(plan.manifests, "ready");
  assert.equal(plan.registry, "ready");
  assert.match(plan.registryIdentity.detail, /scope @civaapple recorded by civaapple/u);

  const order = plan.topologicalBatches.flat();
  const position = new Map(order.map((name, index) => [name, index]));
  for (const pkg of plan.packages) {
    for (const dependency of Object.keys(pkg.internalDependencies)) {
      assert.ok(
        position.get(dependency) < position.get(pkg.name),
        `${dependency} must be published before ${pkg.name}`,
      );
    }
  }
  const extensionNames = new Set(plan.waves.extension);
  for (const pkg of plan.packages.filter(({ wave }) => wave === "core")) {
    assert.equal(
      Object.keys(pkg.internalDependencies).some((name) => extensionNames.has(name)),
      false,
      `${pkg.name} must not depend on the extension publication wave`,
    );
  }
});

test("topological package planning reports cycles rather than inventing an order", () => {
  const packages = [
    { name: "@civaapple/qi-a", internalDependencies: { "@civaapple/qi-b": "1.0.0" } },
    { name: "@civaapple/qi-b", internalDependencies: { "@civaapple/qi-a": "1.0.0" } },
    { name: "@civaapple/qi-base", internalDependencies: {} },
  ];
  const topology = topologicalBatches(packages);
  assert.deepEqual(topology.batches, [["@civaapple/qi-base"]]);
  assert.deepEqual(topology.cycles, ["@civaapple/qi-a", "@civaapple/qi-b"]);
});

test("registry-required package planning validates recorded identity and has no publish executor", async () => {
  const script = join(root, "scripts", "package-release-plan.mjs");
  const result = await execFileAsync(process.execPath, [script, "--require-registry-ready"], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.graphReady, true);
  assert.equal(plan.registry, "ready");
  const implementation = [
    await readFile(script, "utf8"),
    await readFile(join(root, "scripts", "lib", "package-release.mjs"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(implementation, /npm publish/u);
  assert.doesNotMatch(implementation, /\bspawn\s*\(/u);
});
