import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  auditSourceRelease,
  dependencyLicenseInventory,
  run,
} from "../scripts/lib/source-release.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("source release audit proves hygiene and dependency licenses without choosing policy", async () => {
  const fixture = await createReleaseFixture();
  try {
    const report = await auditSourceRelease(fixture.root);
    assert.equal(report.engineeringReady, true);
    assert.equal(report.sourceOpen, "ready");
    assert.equal(report.archive, "ready");
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.dependencies, [{
      name: "fixture-dependency",
      version: "1.0.0",
      license: "MIT",
      development: false,
      optional: false,
      accepted: true,
    }]);

    const token = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    await writeFile(join(fixture.root, "credential.txt"), `${token}\n`, "utf8");
    const unsafe = await auditSourceRelease(fixture.root);
    assert.equal(unsafe.engineeringReady, false);
    assert.equal(
      unsafe.checks.engineering.find(({ id }) => id === "tracked-credential-material").pass,
      false,
    );
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("dependency license inventory rejects missing and unreviewed SPDX identifiers", () => {
  const inventory = dependencyLicenseInventory({
    packages: {
      "node_modules/allowed": { version: "1.0.0", license: "Apache-2.0" },
      "node_modules/blue-oak": { version: "1.0.0", license: "BlueOak-1.0.0" },
      "node_modules/missing": { version: "2.0.0" },
      "node_modules/review": { version: "3.0.0", license: "GPL-3.0-only" },
      "node_modules/workspace": { version: "0.4.0", link: true },
    },
  });
  assert.deepEqual(
    inventory.map(({ name, accepted }) => [name, accepted]),
    [["allowed", true], ["blue-oak", true], ["missing", false], ["review", false]],
  );
});

test("source release CI records the complete engineering gate without publishing", async () => {
  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "source-release-readiness.yml"),
    "utf8",
  );
  assert.match(workflow, /permissions:\s+contents: read/u);
  assert.match(workflow, /npm run release:audit --/u);
  assert.match(workflow, /npm run packages:plan --/u);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run packages:check/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /package-release-plan\.json/u);
  assert.doesNotMatch(workflow, /npm publish/u);
  const parsed = parseYaml(workflow);
  assert.equal(parsed.permissions.contents, "read");
  assert.ok(parsed.jobs["source-release-readiness"].steps.length >= 8);
});

test("source archive is checksum-bearing and fails closed when the candidate is not ready", async () => {
  const fixture = await createReleaseFixture();
  const outputDirectory = join(fixture.temporaryRoot, "release-output");
  const script = join(repositoryRoot, "scripts", "build-source-archive.mjs");
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "--root", fixture.root, "--output-dir", outputDirectory],
      { cwd: repositoryRoot, windowsHide: true },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.status, "pass");
    const bytes = await readFile(result.archive);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), result.sha256);
    assert.equal(
      await readFile(result.checksum, "utf8"),
      `${result.sha256}  ${result.archive.split(/[\\/]/u).at(-1)}\n`,
    );

    await unlink(join(fixture.root, "LICENSE"));
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [script, "--root", fixture.root, "--output-dir", join(fixture.temporaryRoot, "blocked-output")],
        { cwd: repositoryRoot, windowsHide: true },
      ),
      (error) => {
        const blocked = JSON.parse(error.stdout);
        assert.equal(blocked.status, "blocked");
        assert.ok(blocked.blockers.some(({ id }) => id === "license-file"));
        return true;
      },
    );
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

async function createReleaseFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "qi-source-release-test-"));
  const root = join(temporaryRoot, "repository");
  await mkdir(join(root, "packages", "core"), { recursive: true });
  const repository = {
    type: "git",
    url: "https://github.com/qi-test/qi.git",
  };
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "qi",
      version: "1.2.3",
      private: true,
      license: "Apache-2.0",
      repository,
    }, null, 2)}\n`, "utf8"),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify({
      name: "qi",
      version: "1.2.3",
      lockfileVersion: 3,
      packages: {
        "": { name: "qi", version: "1.2.3", license: "Apache-2.0" },
        "node_modules/fixture-dependency": {
          version: "1.0.0",
          license: "MIT",
          resolved: "https://registry.npmjs.org/fixture-dependency/-/fixture-dependency-1.0.0.tgz",
        },
      },
    }, null, 2)}\n`, "utf8"),
    writeFile(join(root, "packages", "core", "package.json"), `${JSON.stringify({
      name: "@civaapple/qi-core",
      version: "1.2.3",
      license: "Apache-2.0",
      repository: { ...repository, directory: "packages/core" },
    }, null, 2)}\n`, "utf8"),
    writeFile(join(root, "LICENSE"), "Apache License fixture\n", "utf8"),
    writeFile(join(root, "CONTRIBUTING.md"), "# Contributing\n", "utf8"),
    writeFile(join(root, "SECURITY.md"), "Report privately to mailto:security@qi.dev.\n", "utf8"),
    writeFile(join(root, "GOVERNANCE.md"), "# Governance\n", "utf8"),
    writeFile(join(root, "CODE_OF_CONDUCT.md"), "# Code of Conduct\n", "utf8"),
  ]);

  await run("git", ["init", "--quiet"], root);
  await run("git", ["config", "user.email", "release-test@qi.dev"], root);
  await run("git", ["config", "user.name", "Qi Release Test"], root);
  await run("git", ["add", "."], root);
  await run("git", ["commit", "--quiet", "-m", "release fixture"], root);
  await run("git", ["remote", "add", "origin", repository.url], root);
  return { root, temporaryRoot };
}
