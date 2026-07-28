import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { parse, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  QI_LAYOUT_GENERATION,
  assertSafePrivateRoot,
  discoverProjects,
  ensureProjectLayout,
  ensureQiLayout,
  projectPaths,
  workspaceProjectId,
} from "@civaapple/qi-node/paths";

test("project IDs normalize Windows and POSIX paths without slug collisions", () => {
  assert.match(workspaceProjectId("D:\\teams\\alpha\\app"), /^app-[0-9a-f]{12}$/);
  assert.match(workspaceProjectId("/teams/alpha/app"), /^app-[0-9a-f]{12}$/);
  assert.notEqual(
    workspaceProjectId("D:\\teams\\alpha\\app"),
    workspaceProjectId("E:\\teams\\alpha\\app"),
  );
  assert.notEqual(
    workspaceProjectId("/teams/alpha/app"),
    workspaceProjectId("/teams/beta/app"),
  );
});

test("0.6 initializes the private QI_HOME and project state layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-layout-"));
  try {
    const workspace = join(root, "workspace");
    const qiHome = join(root, "qi-home");
    await mkdir(workspace);
    const paths = projectPaths({
      workspaceRoot: workspace,
      environment: { QI_HOME: qiHome },
    });
    await ensureProjectLayout(paths);
    const layout = JSON.parse(await readFile(join(qiHome, "layout.json"), "utf8"));
    assert.equal(layout.generation, QI_LAYOUT_GENERATION);
    assert.equal(paths.databaseFile, join(paths.root, "state", "qi.sqlite"));
    assert.equal(paths.effectsFile, join(paths.root, "state", "effects.sqlite"));
    assert.equal(paths.policyFile, join(paths.root, "policy.toml"));
    const descriptor = JSON.parse(await readFile(paths.projectFile, "utf8"));
    assert.equal(descriptor.projectId, paths.projectId);
    assert.equal(descriptor.workspaceRoot, paths.workspaceRoot);
    const discovered = await discoverProjects(qiHome);
    assert.deepEqual(discovered.map((candidate) => candidate.projectId), [paths.projectId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-0.6 QI_HOME is rejected without migration or deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-layout-legacy-"));
  try {
    await writeFile(join(root, "credentials.key"), "old");
    await assert.rejects(
      () => ensureQiLayout(root),
      /unsupported pre-0\.6 layout.*will not migrate or delete/i,
    );
    assert.equal(await readFile(join(root, "credentials.key"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private roots reject Workspace containment, filesystem roots, and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qi-layout-safety-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await assert.rejects(
      () => assertSafePrivateRoot(join(workspace, ".qi", "private"), workspace),
      /must not contain one another/,
    );
    await assert.rejects(
      () => assertSafePrivateRoot(parse(root).root),
      /filesystem root/,
    );
    const target = join(root, "target");
    const link = join(root, "link");
    await mkdir(target);
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`symlink creation unavailable: ${error}`);
      return;
    }
    await assert.rejects(
      () => assertSafePrivateRoot(link),
      /symbolic links|junctions/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--data redirects only project-private paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-layout-data-"));
  try {
    const workspace = join(root, "workspace");
    const qiHome = join(root, "home");
    const dataRoot = join(root, "project-private");
    await mkdir(workspace);
    const paths = projectPaths({
      workspaceRoot: workspace,
      dataRoot,
      environment: { QI_HOME: qiHome },
    });
    assert.equal(paths.root, dataRoot);
    assert.equal(paths.qiHome, qiHome);
    assert.equal(paths.activationFile, join(dataRoot, "packages", "activation.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
