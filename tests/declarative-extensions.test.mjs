import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { c as createTar } from "tar";
import { parseQiPluginManifest } from "@civaapple/qi-agent/extensions";
import {
  assertPinnedPackageSource,
  DeclarativePackageStore,
  resolveLayeredResources,
  validateWorkspaceQiDirectory,
} from "@civaapple/qi-node/extensions";
import { removeFixture } from "./helpers/remove-fixture.mjs";

const execFileAsync = promisify(execFile);

test("Workspace .qi accepts only declaration allowlist content", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-declarations-"));
  try {
    await mkdir(join(root, ".qi", "skills", "review"), { recursive: true });
    await writeFile(join(root, ".qi", "packages.toml"), 'packages = []\n');
    await writeFile(join(root, ".qi", "skills", "review", "SKILL.md"), "# Review\n");
    const valid = await validateWorkspaceQiDirectory(root);
    assert.deepEqual(valid.files, ["packages.toml", "skills/review/SKILL.md"]);

    await writeFile(join(root, ".qi", "skills", "review", "run.js"), "process.exit(0)");
    const withSkillScript = await validateWorkspaceQiDirectory(root);
    assert.ok(withSkillScript.files.includes("skills/review/run.js"));
    await mkdir(join(root, ".qi", "agents"), { recursive: true });
    await writeFile(join(root, ".qi", "agents", "run.js"), "process.exit(0)");
    await assert.rejects(() => validateWorkspaceQiDirectory(root), /Executable content is forbidden/);
  } finally {
    await removeFixture(root);
  }
});

test("Workspace .qi rejects secrets and unknown paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-declarations-denied-"));
  try {
    await mkdir(join(root, ".qi", "mcp"), { recursive: true });
    await writeFile(join(root, ".qi", "mcp", "server.json"), '{"authorization":"Bearer secret-value"}');
    await assert.rejects(() => validateWorkspaceQiDirectory(root), /embedded credential/);
    await rm(join(root, ".qi", "mcp", "server.json"));
    await writeFile(join(root, ".qi", "runtime.sqlite"), "");
    await assert.rejects(() => validateWorkspaceQiDirectory(root), /not allowed/);
    await rm(join(root, ".qi", "runtime.sqlite"));
  } finally {
    await removeFixture(root);
  }
});

test("Workspace .qi rejects symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qi-declarations-link-"));
  try {
    await mkdir(join(root, ".qi", "mcp"), { recursive: true });
    const external = join(root, "external.md");
    await writeFile(external, "outside");
    try {
      await symlink(external, join(root, ".qi", "mcp", "linked.md"));
    } catch (error) {
      t.skip(`symlink creation unavailable: ${error}`);
      return;
    }
    await assert.rejects(() => validateWorkspaceQiDirectory(root), /Symlinks are forbidden/);
  } finally {
    await removeFixture(root);
  }
});

test("declarative manifest has no executable or authority surface", () => {
  assert.throws(
    () => parseQiPluginManifest({
      schemaVersion: 1,
      id: "unsafe",
      version: "1.0.0",
      capabilities: ["write"],
      resources: [],
    }),
    /must not define capabilities/,
  );
  assert.throws(
    () => parseQiPluginManifest({
      schemaVersion: 1,
      id: "unsafe",
      version: "1.0.0",
      resources: [{ kind: "skills", id: "run", path: "run.ts" }],
    }),
    /executable content/,
  );
});

test("local package install is content-addressed, deduplicated, and script-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-package-store-"));
  try {
    const qiHome = join(root, "home");
    const source = join(root, "source");
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "qi-plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "review-pack",
      version: "1.0.0",
      resources: [{ kind: "skills", id: "review", path: "skills/review/SKILL.md" }],
    }));
    await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n");
    const store = new DeclarativePackageStore(qiHome);
    const first = await store.installLocal(source);
    const second = await store.installLocal(source);
    assert.equal(first.source.digest, second.source.digest);
    assert.equal(first.storePath, second.storePath);
    assert.match(first.source.digest, /^sha256-[0-9a-f]{64}$/);
    const lock = JSON.parse(await readFile(join(qiHome, "packages", "lock.json"), "utf8"));
    assert.equal(lock.packages["review-pack"].source.digest, first.source.digest);

    await chmod(source, 0o755).catch(() => undefined);
    await writeFile(join(source, "package.json"), '{"scripts":{"postinstall":"node run.js"}}');
    await assert.rejects(() => store.installLocal(source), /must not contain npm lifecycle/);
  } finally {
    await removeFixture(root);
  }
});

test("npm package install requires exact metadata integrity and never executes scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-package-npm-"));
  let server;
  try {
    const archiveRoot = join(root, "archive");
    const packageRoot = join(archiveRoot, "package");
    await mkdir(join(packageRoot, "prompts"), { recursive: true });
    await writeFile(join(packageRoot, "qi-plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "npm-pack",
      version: "1.2.3",
      resources: [{ kind: "prompts", id: "npm-review", path: "prompts/review.md" }],
    }));
    await writeFile(join(packageRoot, "prompts", "review.md"), "# npm review\n");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "npm-pack",
      version: "1.2.3",
    }));
    const archive = join(root, "npm-pack.tgz");
    await createTar({ cwd: archiveRoot, file: archive, gzip: true, portable: true }, ["package"]);
    const bytes = await readFile(archive);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    server = createServer((request, response) => {
      const address = server.address();
      const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      if (request.url === "/npm-pack/1.2.3") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          version: "1.2.3",
          dist: { tarball: `${origin}/npm-pack.tgz`, integrity },
        }));
      } else if (request.url === "/npm-pack.tgz") {
        response.end(bytes);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const registry = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const installed = await new DeclarativePackageStore(join(root, "home"))
      .installNpm("npm-pack@1.2.3", { registry });
    assert.equal(installed.source.integrity, integrity);
    assert.equal(installed.source.resolved, "npm-pack@1.2.3");
    await assert.rejects(
      () => new DeclarativePackageStore(join(root, "other")).installNpm("npm-pack@latest", { registry }),
      /exact semver/,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await removeFixture(root);
  }
});

test("Git package install resolves only an exact commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qi-package-git-"));
  try {
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      t.skip("git is unavailable");
      return;
    }
    const repository = join(root, "repository");
    await mkdir(join(repository, "agents"), { recursive: true });
    await execFileAsync("git", ["init", repository], { windowsHide: true });
    await writeFile(join(repository, "qi-plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "git-pack",
      version: "1.0.0",
      resources: [{ kind: "agents", id: "reviewer", path: "agents/reviewer.yaml" }],
    }));
    await writeFile(join(repository, "agents", "reviewer.yaml"), "id: reviewer\n");
    await execFileAsync("git", ["-C", repository, "add", "."], { windowsHide: true });
    await execFileAsync("git", [
      "-C", repository,
      "-c", "user.name=Qi Test",
      "-c", "user.email=qi@example.invalid",
      "commit", "-m", "fixture",
    ], { windowsHide: true });
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], {
      windowsHide: true,
    });
    const commit = stdout.trim();
    const installed = await new DeclarativePackageStore(join(root, "home"))
      .installGit(`${repository}#${commit}`);
    assert.equal(installed.source.resolved, `${repository}#${commit}`);
    await assert.rejects(
      () => new DeclarativePackageStore(join(root, "other")).installGit(`${repository}#main`),
      /exact/,
    );
  } finally {
    await removeFixture(root);
  }
});

test("pinned source validation rejects mutable npm and Git references", () => {
  assert.doesNotThrow(() => assertPinnedPackageSource({
    type: "npm",
    resolved: "@scope/review@1.2.3",
    integrity: "sha512-YQ==",
  }));
  assert.throws(
    () => assertPinnedPackageSource({ type: "npm", resolved: "review@latest" }),
    /exact version/,
  );
  assert.throws(
    () => assertPinnedPackageSource({ type: "git", resolved: "https://example.invalid/review.git#main" }),
    /exact 40-character commit/,
  );
});

test("resource precedence is fixed and same-layer conflicts fail", () => {
  const selected = resolveLayeredResources([
    { layer: "builtins", kind: "skills", id: "review", source: "builtin" },
    { layer: "user-packages", kind: "skills", id: "review", source: "user" },
    { layer: "project-direct", kind: "skills", id: "review", source: "project" },
  ]);
  assert.deepEqual(selected.map((resource) => resource.source), ["project"]);
  assert.throws(
    () => resolveLayeredResources([
      { layer: "project-packages", kind: "skills", id: "same", source: "a" },
      { layer: "project-packages", kind: "skills", id: "same", source: "b" },
    ]),
    /Conflicting resource/,
  );
});
