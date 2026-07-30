import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { createId } from "@civaapple/qi-protocol";
import {
  SessionArchiveBlockedError,
  SessionRepository,
  SqliteEventStore,
} from "@civaapple/qi-node/storage";
import {
  ensureProjectLayout,
  ensureProjectSessionLayout,
  projectPaths,
  projectSessionPaths,
} from "@civaapple/qi-node/paths";

test("SessionRepository hard-archives a self-contained Session and restores replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-session-repository-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const paths = projectPaths({
      workspaceRoot: workspace,
      environment: { QI_HOME: join(root, "home") },
    });
    await ensureProjectLayout(paths);
    const sessionId = createId("ses");
    const sessionPaths = projectSessionPaths(paths, sessionId);
    await ensureProjectSessionLayout(sessionPaths);
    const repository = new SessionRepository(paths);
    new EventWriter(repository, sessionId).append(
      "session.created",
      { title: "Archive me" },
      { kind: "user", id: "test" },
    );
    await writeFile(join(sessionPaths.artifactsRoot, "owned.txt"), "session-owned", "utf8");

    await repository.archive(sessionId);
    assert.equal(repository.load(sessionId), undefined);
    assert.equal(repository.listCatalog("archived")[0]?.lifecycle, "archived");
    assert.equal(
      await readFile(join(projectSessionPaths(paths, sessionId, "archived").artifactsRoot, "owned.txt"), "utf8"),
      "session-owned",
    );

    await repository.restore(sessionId);
    assert.equal(repository.load(sessionId)?.lifecycle, "active");
    assert.deepEqual(
      repository.read(sessionId).events.slice(-4).map((event) => event.type),
      [
        "session.archive.requested",
        "session.archived",
        "session.restore.requested",
        "session.restored",
      ],
    );
    repository.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kernel freezes ordinary events during archive/restore and records model configuration", () => {
  const store = new InMemoryEventStore();
  const sessionId = createId("ses");
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", {}, { kind: "user", id: "test" });
  writer.append("session.model.configured", {
    provider: "compatible",
    accountAlias: "local",
    model: "vision-local",
    contextWindowTokens: 128_000,
    imageInput: true,
    persistence: "session",
  }, { kind: "user", id: "test" });
  assert.equal(store.load(sessionId)?.modelConfiguration?.imageInput, true);
  assert.throws(
    () => writer.append(
      "session.restore.requested",
      { operationId: "restore_too_early" },
      { kind: "user", id: "test" },
    ),
    /Session is active/,
  );
  writer.append(
    "session.archive.requested",
    { operationId: "archive_test", reason: "test" },
    { kind: "user", id: "test" },
  );
  assert.throws(
    () => writer.append(
      "session.mode.changed",
      { from: "agent", to: "ask", reason: "too late" },
      { kind: "user", id: "test" },
    ),
    /archive_pending/,
  );
});

test("SessionRepository recover finishes interrupted archive, restore, and missing manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-session-recover-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const paths = projectPaths({
      workspaceRoot: workspace,
      environment: { QI_HOME: join(root, "home") },
    });
    await ensureProjectLayout(paths);

    const pendingMove = createId("ses");
    await ensureProjectSessionLayout(projectSessionPaths(paths, pendingMove));
    const pendingRepo = new SessionRepository(paths);
    new EventWriter(pendingRepo, pendingMove).append(
      "session.created",
      { title: "pending move" },
      { kind: "user", id: "test" },
    );
    new EventWriter(pendingRepo, pendingMove).append(
      "session.archive.requested",
      { operationId: "archive_pending_move", reason: "crash before rename" },
      { kind: "user", id: "test" },
    );
    pendingRepo.close();

    const movedPending = createId("ses");
    await ensureProjectSessionLayout(projectSessionPaths(paths, movedPending));
    const movedRepo = new SessionRepository(paths);
    new EventWriter(movedRepo, movedPending).append(
      "session.created",
      { title: "moved pending" },
      { kind: "user", id: "test" },
    );
    new EventWriter(movedRepo, movedPending).append(
      "session.archive.requested",
      { operationId: "archive_moved_pending", reason: "crash after rename" },
      { kind: "user", id: "test" },
    );
    movedRepo.release(movedPending);
    await rename(
      projectSessionPaths(paths, movedPending, "active").root,
      projectSessionPaths(paths, movedPending, "archived").root,
    );
    movedRepo.close();

    const missingManifest = createId("ses");
    await ensureProjectSessionLayout(projectSessionPaths(paths, missingManifest));
    const archiveRepo = new SessionRepository(paths);
    new EventWriter(archiveRepo, missingManifest).append(
      "session.created",
      { title: "missing manifest" },
      { kind: "user", id: "test" },
    );
    await archiveRepo.archive(missingManifest);
    await rm(projectSessionPaths(paths, missingManifest, "archived").archiveManifestFile, { force: true });
    archiveRepo.close();

    const restorePending = createId("ses");
    await ensureProjectSessionLayout(projectSessionPaths(paths, restorePending));
    const restoreRepo = new SessionRepository(paths);
    new EventWriter(restoreRepo, restorePending).append(
      "session.created",
      { title: "restore pending" },
      { kind: "user", id: "test" },
    );
    await restoreRepo.archive(restorePending);
    const archivedPaths = projectSessionPaths(paths, restorePending, "archived");
    const archivedStore = new SqliteEventStore(archivedPaths.databaseFile);
    try {
      new EventWriter(archivedStore, restorePending).append(
        "session.restore.requested",
        { operationId: "restore_pending_crash" },
        { kind: "user", id: "test" },
      );
    } finally {
      archivedStore.close();
    }
    restoreRepo.close();

    const recovered = new SessionRepository(paths);
    await recovered.recover();

    assert.equal(
      recovered.listCatalog("archived").find((entry) => entry.sessionId === pendingMove)?.lifecycle,
      "archived",
    );
    assert.equal(
      await readFile(projectSessionPaths(paths, pendingMove, "archived").archiveManifestFile, "utf8").then(() => true),
      true,
    );
    assert.equal(
      recovered.listCatalog("archived").find((entry) => entry.sessionId === movedPending)?.lifecycle,
      "archived",
    );
    assert.equal(
      recovered.listCatalog("archived").find((entry) => entry.sessionId === missingManifest)?.lifecycle,
      "archived",
    );
    assert.equal(
      await readFile(projectSessionPaths(paths, missingManifest, "archived").archiveManifestFile, "utf8").then(() => true),
      true,
    );
    assert.equal(recovered.load(restorePending)?.lifecycle, "active");
    recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionRepository recover resumes an interrupted workspace reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-session-reset-recover-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const paths = projectPaths({
      workspaceRoot: workspace,
      environment: { QI_HOME: join(root, "home") },
    });
    await ensureProjectLayout(paths);
    const repository = new SessionRepository(paths);
    const first = createId("ses");
    const second = createId("ses");
    for (const sessionId of [first, second]) {
      await ensureProjectSessionLayout(projectSessionPaths(paths, sessionId));
      new EventWriter(repository, sessionId).append(
        "session.created",
        { title: sessionId },
        { kind: "user", id: "test" },
      );
    }
    repository.close();

    const journalFile = join(paths.stateRoot, "reset-operation.json");
    await writeFile(journalFile, JSON.stringify({
      schemaVersion: 1,
      operationId: "reset_crash",
      sessionIds: [first, second],
      completed: [],
    }), "utf8");

    const recovered = new SessionRepository(paths);
    await recovered.recover();
    assert.equal(recovered.listSessions().length, 0);
    assert.deepEqual(
      recovered.listCatalog("archived").map((entry) => entry.sessionId).sort(),
      [first, second].sort(),
    );
    await assert.rejects(() => readFile(journalFile, "utf8"), /ENOENT/);
    recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionRepository preflights every Session before reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-session-reset-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const paths = projectPaths({
      workspaceRoot: workspace,
      environment: { QI_HOME: join(root, "home") },
    });
    await ensureProjectLayout(paths);
    const repository = new SessionRepository(paths);
    const idle = createId("ses");
    const busy = createId("ses");
    new EventWriter(repository, idle).append("session.created", {}, { kind: "user", id: "test" });
    const writer = new EventWriter(repository, busy);
    writer.append("session.created", {}, { kind: "user", id: "test" });
    writer.append(
      "run.triggered",
      { runId: createId("run"), trigger: "user", input: "busy" },
      { kind: "user", id: "test" },
    );

    await assert.rejects(
      () => repository.resetWorkspace(),
      (error) => error instanceof SessionArchiveBlockedError && /Run .* triggered/.test(error.message),
    );
    assert.deepEqual(
      repository.listSessions().map((entry) => entry.sessionId).sort(),
      [busy, idle].sort(),
    );
    assert.equal(repository.listCatalog("archived").length, 0);
    repository.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
