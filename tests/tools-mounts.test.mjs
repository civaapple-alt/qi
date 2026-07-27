import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "../packages/capability/dist/index.js";
import {
  FileArtifactStore,
  ToolFailure,
  ToolRegistry,
  readTool,
  writeTool,
  resolveAccessiblePath,
} from "../packages/tools/dist/index.js";

function grant(broker) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  broker.grant({
    leaseId: "lea_test_read",
    subject: "tester",
    tools: ["read", "write"],
    effects: ["read", "write"],
    resources: ["file:**", "tree:**"],
    expiresAt,
  });
}

function context(root, artifactStore, actionId, mounts = []) {
  return {
    sessionId: "ses_mount",
    runId: "run_mount",
    stepId: "stp_mount",
    actionId,
    subject: "tester",
    workspaceRoot: root,
    artifactStore,
    mounts,
    getMounts: () => mounts,
  };
}

test("read-only mounts resolve via mount:<id>/ and reject mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mounts-"));
  try {
    const workspace = join(root, "ws");
    const other = join(root, "other");
    await mkdir(workspace);
    await mkdir(other);
    await writeFile(join(workspace, "local.txt"), "local\n", "utf8");
    await writeFile(join(other, "remote.txt"), "remote\n", "utf8");
    const artifactStore = new FileArtifactStore(join(root, "artifacts"));
    const mounts = [{ id: "other", path: other, mode: "read" }];

    const resolved = await resolveAccessiblePath(workspace, "mount:other/remote.txt", mounts);
    assert.equal(resolved.rootKind, "mount");
    assert.equal(resolved.mountId, "other");
    assert.equal(resolved.absolute, resolve(other, "remote.txt"));

    await assert.rejects(
      () => resolveAccessiblePath(workspace, resolve(other, "remote.txt"), mounts),
      (error) => error instanceof ToolFailure && error.code === "PATH_OUTSIDE_WORKSPACE",
    );
    await assert.rejects(
      () => resolveAccessiblePath(workspace, resolve(root, "nowhere", "file.txt"), mounts),
      (error) => error instanceof ToolFailure && error.code === "PATH_GRANT_REQUIRED",
    );

    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("write", writeTool);

    const readIdentity = registry.catalog().find((entry) => entry.name === "read")?.identity;
    const writeIdentity = registry.catalog().find((entry) => entry.name === "write")?.identity;
    assert.ok(readIdentity && writeIdentity);

    const read = await registry.execute(
      "read",
      readIdentity,
      { path: "mount:other/remote.txt" },
      context(workspace, artifactStore, "act_read_mount", mounts),
    );
    assert.equal(read.output.content, "remote\n");
    assert.equal(read.output.path, "mount:other/remote.txt");

    await assert.rejects(
      registry.execute(
        "write",
        writeIdentity,
        { path: "mount:other/remote.txt", content: "nope\n", expectedSha256: null },
        context(workspace, artifactStore, "act_write_mount", mounts),
      ),
      (error) => error instanceof ToolFailure && error.code === "PATH_OUTSIDE_WORKSPACE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
