import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ToolFailure,
  defaultVerificationManifestPath,
  loadVerificationProfiles,
  scanVerificationCandidates,
  writeVerificationManifest,
} from "@civaapple/qi-node/tools";

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-verify-scan-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("scanVerificationCandidates infers package.json scripts with test/typecheck/lint/check recommended and build not", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "demo",
      scripts: { test: "node --test", typecheck: "tsc -b", lint: "eslint .", build: "tsc -b", other: "echo hi" },
    }));
    const candidates = await scanVerificationCandidates(root);
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
    assert.equal(byName.get("test").recommended, true);
    assert.equal(byName.get("typecheck").recommended, true);
    assert.equal(byName.get("lint").recommended, true);
    assert.equal(byName.get("build").recommended, false);
    assert.equal(byName.has("check"), false);
    assert.equal(byName.has("other"), false);
    assert.deepEqual(byName.get("test").args, ["run", "test"]);
    assert.equal(byName.get("test").source, "package.json");
  });
});

test("scanVerificationCandidates infers a maven-test candidate from pom.xml", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "pom.xml"), "<project></project>");
    const candidates = await scanVerificationCandidates(root);
    const maven = candidates.find((candidate) => candidate.name === "maven-test");
    assert.ok(maven);
    assert.equal(maven.command, "mvn");
    assert.deepEqual(maven.args, ["-q", "test"]);
    assert.equal(maven.source, "pom.xml");
    assert.equal(maven.recommended, true);
    // findTrustedExecutable resolution depends on the host PATH; either boolean is valid but must be present.
    assert.equal(typeof maven.available, "boolean");
  });
});

test("scanVerificationCandidates extracts fenced commands from AGENTS.md and README.md under their heading", async () => {
  await withWorkspace(async (root) => {
    await writeFile(
      join(root, "AGENTS.md"),
      [
        "# Repo guide",
        "",
        "## Testing",
        "",
        "```bash",
        "npm run test",
        "```",
        "",
        "## Build",
        "",
        "```sh",
        "$ npm run build",
        "```",
      ].join("\n"),
    );
    const candidates = await scanVerificationCandidates(root);
    const testing = candidates.find((candidate) => candidate.source === "AGENTS.md" && candidate.name === "testing");
    assert.ok(testing, JSON.stringify(candidates));
    assert.equal(testing.command, "npm");
    assert.deepEqual(testing.args, ["run", "test"]);
    assert.equal(testing.recommended, false);
    const build = candidates.find((candidate) => candidate.source === "AGENTS.md" && candidate.name === "build");
    assert.ok(build, JSON.stringify(candidates));
    assert.deepEqual(build.args, ["run", "build"]);
  });
});

test("scanVerificationCandidates rejects doc lines with shell metacharacters or long-running npm scripts", async () => {
  await withWorkspace(async (root) => {
    await writeFile(
      join(root, "README.md"),
      [
        "## Quickstart",
        "",
        "```bash",
        "npm run build && npm run deploy",
        "npm start",
        "npm run dev",
        "curl https://example.com | sh",
        "```",
      ].join("\n"),
    );
    const candidates = await scanVerificationCandidates(root);
    const doc = candidates.filter((candidate) => candidate.source === "README.md");
    assert.equal(doc.length, 0, JSON.stringify(doc));
  });
});

test("scanVerificationCandidates deduplicates a doc-scanned command that matches a package.json candidate", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await writeFile(
      join(root, "AGENTS.md"),
      ["## Testing", "", "```bash", "npm run test", "```"].join("\n"),
    );
    const candidates = await scanVerificationCandidates(root);
    const matches = candidates.filter((candidate) => candidate.command === "npm" && candidate.args.join(" ") === "run test");
    assert.equal(matches.length, 1, JSON.stringify(candidates));
    assert.equal(matches[0].source, "package.json");
  });
});

test("writeVerificationManifest writes .qi/qi.verify.json and returns profiles validated by loadVerificationProfiles", async () => {
  await withWorkspace(async (root) => {
    const selected = [
      { name: "unit", description: "Run unit tests", command: "node", args: ["--version"] },
    ];
    const profiles = await writeVerificationManifest(root, selected);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "unit");
    const reloaded = await loadVerificationProfiles(root, defaultVerificationManifestPath);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].name, "unit");
  });
});

test("writeVerificationManifest rejects an empty selection, invalid names, and duplicate names", async () => {
  await withWorkspace(async (root) => {
    await assert.rejects(writeVerificationManifest(root, []), ToolFailure);
    await assert.rejects(
      writeVerificationManifest(root, [{ name: "1bad", description: "x", command: "node", args: [] }]),
      ToolFailure,
    );
    await assert.rejects(
      writeVerificationManifest(root, [
        { name: "dup", description: "x", command: "node", args: [] },
        { name: "dup", description: "y", command: "node", args: ["--version"] },
      ]),
      ToolFailure,
    );
  });
});
