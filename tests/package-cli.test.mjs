import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runPackageCliCommand } from "../apps/cli/dist/package-command.js";
import { projectPaths } from "@civaapple/qi-node/paths";

async function createPlugin(root) {
  const source = join(root, "plugin");
  await mkdir(join(source, "prompts"), { recursive: true });
  await writeFile(join(source, "qi-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "sample-pack",
    version: "1.0.0",
    resources: [{ kind: "prompts", id: "review", path: "prompts/review.md" }],
  }));
  await writeFile(join(source, "prompts", "review.md"), "# Review\n");
  return source;
}

test("qi install/list/remove manages user declarative package scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-package-cli-user-"));
  try {
    const qiHome = join(root, "home");
    const source = await createPlugin(root);
    const output = [];
    const common = { cwd: root, environment: { QI_HOME: qiHome }, write: (text) => output.push(text) };
    assert.equal(await runPackageCliCommand(["install", `local:${source}`], common), true);
    assert.match(output.at(-1), /Installed sample-pack@1\.0\.0/);
    output.length = 0;
    await runPackageCliCommand(["list"], common);
    assert.match(output.join(""), /sample-pack\t1\.0\.0\tsha256-/);
    await runPackageCliCommand(["remove", "sample-pack"], common);
    const lock = JSON.parse(await readFile(join(qiHome, "packages", "lock.json"), "utf8"));
    assert.deepEqual(lock.packages, {});
    assert.match(await readFile(join(qiHome, "packages", "installed.toml"), "utf8"), /^version = 1/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project package scope writes only declarations to .qi and private activation to QI_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-package-cli-project-"));
  try {
    const qiHome = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const source = await createPlugin(root);
    await runPackageCliCommand([
      "install",
      `local:${source}`,
      "--scope",
      "project",
      "--workspace",
      workspace,
    ], {
      cwd: root,
      environment: { QI_HOME: qiHome },
      write: () => undefined,
    });
    const sharedLock = JSON.parse(await readFile(join(workspace, ".qi", "packages.lock.json"), "utf8"));
    assert.match(sharedLock.packages["sample-pack"].source.digest, /^sha256-/);
    const paths = projectPaths({ workspaceRoot: workspace, environment: { QI_HOME: qiHome } });
    const activation = JSON.parse(await readFile(paths.activationFile, "utf8"));
    assert.equal(
      activation.packages["sample-pack"].digest,
      sharedLock.packages["sample-pack"].source.digest,
    );
    await assert.rejects(
      () => readFile(join(workspace, ".qi", "packages", "sample-pack", "qi-plugin.json")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
