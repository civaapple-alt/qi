import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryEventStore, StateTransitionError } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { ContinuityController, MemoryController } from "@civaapple/qi-agent/memory";
import { SqliteMemoryIndex } from "@civaapple/qi-node/storage";

function createSession(store, sessionId) {
  const writer = new EventWriter(store, sessionId);
  const event = writer.append("session.created", { title: sessionId }, { kind: "runtime", id: "test" });
  return { sessionId, event };
}

function userMemorySource(store, sessionId, statement, scope) {
  return new EventWriter(store, sessionId).append(
    "memory.user.asserted",
    { operationId: `assertion-${store.read(sessionId).version + 1}`, statement, scope },
    { kind: "user", id: "local" },
  );
}

test("accepted project memory crosses Sessions, while correction and forgetting remove old claims from retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-"));
  const store = new InMemoryEventStore();
  const first = createSession(store, "ses_memory_first");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const firstController = new MemoryController(store, index, first.sessionId);
  const oldId = firstController.candidate({
    layer: "semantic",
    statement: "The project uses pnpm.",
    scope: "project:fastai",
    provenance: [{ sessionId: first.sessionId, eventId: first.event.eventId, sequence: first.event.sequence }],
    confidence: 0.9,
    sensitivity: "public",
  });
  firstController.accept(oldId, { kind: "runtime", id: "deterministic-projector" });

  const second = createSession(store, "ses_memory_second");
  const secondController = new MemoryController(store, index, second.sessionId);
  assert.deepEqual(secondController.retrieve({ scopes: ["project:fastai"], query: "pnpm" }).map((claim) => claim.memoryId), [oldId]);
  const blocks = secondController.contextBlocks({ scopes: ["project:fastai"], query: "project" });
  assert.equal(blocks[0].content, "The project uses pnpm.");
  assert.match(blocks[0].retentionReason, /ses_memory_first#1/);

  const corrected = secondController.correct(oldId, {
    layer: "semantic",
    statement: "The project uses npm workspaces.",
    provenance: [{ sessionId: second.sessionId, eventId: second.event.eventId, sequence: second.event.sequence }],
    confidence: 1,
    sensitivity: "public",
  }, "user");
  assert.equal(corrected.contradictionOf, oldId);
  assert.equal(index.get(oldId).status, "disputed");
  assert.equal(store.load(first.sessionId).memories[corrected.memoryId].status, "accepted");
  assert.equal(store.load(second.sessionId).memories[corrected.memoryId], undefined);
  const correctionEvents = store.read(first.sessionId).events.slice(-3);
  assert.deepEqual(
    correctionEvents.map((event) => event.type),
    ["memory.candidate.created", "memory.accepted", "memory.disputed"],
  );
  assert.deepEqual(secondController.retrieve({ scopes: ["project:fastai"], query: "project" }).map((claim) => claim.memoryId), [corrected.memoryId]);
  assert.equal(secondController.retrieve({ scopes: ["project:fastai"], query: "pnpm" }).length, 0);

  secondController.forget(corrected.memoryId, "User requested deletion", "user");
  assert.equal(secondController.retrieve({ scopes: ["project:fastai"], query: "project" }).length, 0);
  assert.equal(store.load(first.sessionId).memories[corrected.memoryId].status, "forgotten");
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("relational or sensitive candidates require explicit user confirmation and Agent cannot self-accept", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-confirm-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_confirm");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const controller = new MemoryController(store, index, session.sessionId);
  const memoryId = controller.candidate({
    layer: "relational",
    statement: "The user prefers concise status updates.",
    scope: "user:local",
    provenance: [{ sessionId: session.sessionId, eventId: session.event.eventId, sequence: 1 }],
    confidence: 0.7,
    sensitivity: "private",
  });
  assert.equal(index.get(memoryId).requiresConfirmation, true);
  assert.throws(
    () => controller.accept(memoryId, { kind: "agent", id: "agent" }),
    (error) => error instanceof StateTransitionError && error.code === "AGENT_CANNOT_ACCEPT_MEMORY",
  );
  controller.accept(memoryId, { kind: "user", id: "user" });
  assert.equal(controller.retrieve({ scopes: ["user:local"], query: "concise" })[0].memoryId, memoryId);
  assert.equal(controller.retrieve({ scopes: ["user:local"], query: "concise", maximumSensitivity: "public" }).length, 0);
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("working and expired claims never re-enter long-lived context", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-expiry-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_expiry");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const controller = new MemoryController(store, index, session.sessionId);
  for (const candidate of [
    { layer: "working", statement: "Temporary variable is 4", expiresAt: undefined },
    { layer: "semantic", statement: "Old project fact", expiresAt: "2025-01-01T00:00:00.000Z" },
  ]) {
    const memoryId = controller.candidate({
      ...candidate,
      scope: "project:fastai",
      provenance: [{ sessionId: session.sessionId, eventId: session.event.eventId, sequence: 1 }],
      confidence: 1,
      sensitivity: "public",
    });
    controller.accept(memoryId, { kind: "runtime", id: "projector" });
  }
  assert.equal(controller.retrieve({ scopes: ["project:fastai"], now: new Date("2026-01-01T00:00:00.000Z") }).length, 0);
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("memory provenance must point to a real immutable Session event", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-provenance-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_provenance");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const controller = new MemoryController(store, index, session.sessionId);
  assert.throws(() => controller.candidate({
    layer: "semantic",
    statement: "Unsupported claim",
    scope: "project:fastai",
    provenance: [{ sessionId: session.sessionId, eventId: "evt_missing_001", sequence: 99 }],
    confidence: 1,
    sensitivity: "public",
  }), /provenance.*missing/i);
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("structured scopes isolate projects, support CJK retrieval, and honor validFrom", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-scope-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_scope");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const controller = new MemoryController(store, index, session.sessionId, {
    clock: () => new Date("2026-07-29T10:00:00.000Z"),
  });
  const scope = { kind: "project", projectId: "project-a" };
  const source = userMemorySource(store, session.sessionId, "项目使用中文检索和稳定排序。", scope);
  const visible = controller.propose({
    operationId: "scope:cjk",
    layer: "semantic",
    statement: "项目使用中文检索和稳定排序。",
    scope,
    provenance: [{ projectId: "project-a", sessionId: session.sessionId, eventId: source.eventId, sequence: source.sequence }],
    confidence: 1,
    sensitivity: "public",
  }, { actorId: "projector", autoAccept: true });
  controller.propose({
    operationId: "scope:cjk-duplicate",
    layer: "semantic",
    statement: "  项目使用中文检索和稳定排序。  ",
    scope,
    provenance: [{ projectId: "project-a", sessionId: session.sessionId, eventId: source.eventId, sequence: source.sequence }],
    confidence: 0.9,
    sensitivity: "public",
  }, { actorId: "projector", autoAccept: true });
  controller.propose({
    operationId: "scope:future",
    layer: "semantic",
    statement: "未来才生效的项目事实",
    scope,
    provenance: [{ projectId: "project-a", sessionId: session.sessionId, eventId: source.eventId, sequence: source.sequence }],
    confidence: 1,
    sensitivity: "public",
    validFrom: "2027-01-01T00:00:00.000Z",
  }, { actorId: "projector", autoAccept: true });

  assert.deepEqual(
    controller.retrieve({ scopes: [scope], query: "中文", now: new Date("2026-07-29T10:01:00.000Z") })
      .map((claim) => claim.memoryId),
    [visible.memoryId],
  );
  assert.equal(controller.retrieve({
    scopes: [{ kind: "project", projectId: "project-b" }],
    query: "中文",
  }).length, 0);
  assert.equal(controller.retrieve({
    scopes: [scope],
    query: "未来",
    now: new Date("2026-07-29T10:01:00.000Z"),
  }).length, 0);
  const correctionSource = userMemorySource(store, session.sessionId, "项目改用新的检索器。", scope);
  const correction = controller.propose({
    operationId: "scope:correction",
    layer: "semantic",
    statement: "项目改用新的检索器。",
    scope,
    provenance: [{
      projectId: "project-a",
      sessionId: session.sessionId,
      eventId: correctionSource.eventId,
      sequence: correctionSource.sequence,
    }],
    confidence: 1,
    sensitivity: "public",
    contradictionOf: visible.memoryId,
    requiresConfirmation: true,
  });
  assert.equal(correction.status, "candidate");
  controller.accept(correction.memoryId, { kind: "user", id: "local" });
  assert.equal(index.get(visible.memoryId).status, "disputed");
  assert.equal(index.get(correction.memoryId).status, "accepted");
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("only users can activate accepted User Memory and at most four may be always active", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-activation-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_activation");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const controller = new MemoryController(store, index, session.sessionId);
  const scope = { kind: "user", userId: "local" };
  const source = userMemorySource(store, session.sessionId, "User preference source", scope);
  const ids = [];
  for (let indexValue = 0; indexValue < 5; indexValue += 1) {
    const claim = controller.propose({
      operationId: `activation:${indexValue}`,
      layer: "semantic",
      statement: `User preference ${indexValue}`,
      scope,
      provenance: [{ projectId: "project-a", sessionId: session.sessionId, eventId: source.eventId, sequence: source.sequence }],
      confidence: 1,
      sensitivity: "private",
      requiresConfirmation: true,
    }, { actorId: "memory" });
    controller.accept(claim.memoryId, { kind: "user", id: "local" });
    ids.push(claim.memoryId);
  }
  assert.throws(
    () => new EventWriter(store, session.sessionId).append(
      "memory.activation.changed",
      { memoryId: ids[0], activation: "always" },
      { kind: "agent", id: "agent" },
    ),
    (error) => error instanceof StateTransitionError && error.code === "MEMORY_ACTIVATION_REQUIRES_USER",
  );
  assert.throws(
    () => new EventWriter(store, session.sessionId).append(
      "memory.disputed",
      { memoryId: ids[0], reason: "Agent attempted correction" },
      { kind: "agent", id: "agent" },
    ),
    (error) => error instanceof StateTransitionError && error.code === "MEMORY_DISPUTE_REQUIRES_USER",
  );
  for (const memoryId of ids.slice(0, 4)) {
    assert.equal(controller.setActivation(memoryId, "always", "local").activation, "always");
  }
  assert.throws(
    () => controller.setActivation(ids[4], "always", "local"),
    (error) => error instanceof StateTransitionError && error.code === "MEMORY_ALWAYS_LIMIT",
  );
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("credential-like Memory is rejected before a candidate event is committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-secret-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_secret");
  const index = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  const controller = new MemoryController(store, index, session.sessionId);
  const scope = { kind: "project", projectId: "project-a" };
  const source = userMemorySource(store, session.sessionId, "Memory proposal source", scope);
  assert.throws(() => controller.propose({
    layer: "semantic",
    statement: "Use API key sk-1234567890abcdefghijklmnop",
    scope,
    provenance: [{ projectId: "project-a", sessionId: session.sessionId, eventId: source.eventId, sequence: source.sequence }],
    confidence: 1,
    sensitivity: "secret",
  }), /credential-like secret/i);
  assert.deepEqual(
    store.read(session.sessionId).events.map((event) => event.type),
    ["session.created", "memory.user.asserted"],
  );
  index.close();
  await rm(root, { recursive: true, force: true });
});

test("SQLite v1 Memory rows migrate in place and remain quarantined as legacy scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-migration-"));
  const path = join(root, "memory.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE memory_claims (
      memory_id TEXT PRIMARY KEY,
      origin_session_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      statement TEXT NOT NULL,
      scope TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      sensitivity TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      expires_at TEXT,
      contradiction_of TEXT,
      requires_confirmation INTEGER NOT NULL,
      status TEXT NOT NULL,
      confirmed_by TEXT,
      status_reason TEXT,
      correction_memory_id TEXT
    ) STRICT;
  `);
  legacy.prepare(`
    INSERT INTO memory_claims (
      memory_id,origin_session_id,layer,statement,scope,provenance_json,confidence,
      sensitivity,valid_from,requires_confirmation,status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    "mem_legacy_scope",
    "ses_legacy_scope",
    "semantic",
    "Legacy project fact",
    "project:old-project",
    "[]",
    1,
    "public",
    "2025-01-01T00:00:00.000Z",
    0,
    "accepted",
  );
  legacy.close();

  const index = new SqliteMemoryIndex(path);
  assert.equal(index.get("mem_legacy_scope").scope, "project:old-project");
  assert.equal(index.get("mem_legacy_scope").activation, "relevant");
  assert.equal(index.search({
    scopes: [{ kind: "project", projectId: "old-project" }],
    query: "Legacy",
  }).length, 0);
  index.close();
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 2);
  migrated.close();
  await rm(root, { recursive: true, force: true });
});

test("committed Memory recovers an interrupted index batch without duplicating the operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-memory-recovery-"));
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_memory_recovery");
  const durableIndex = new SqliteMemoryIndex(join(root, "memory.sqlite"));
  let failNextBatch = true;
  const flakyIndex = {
    apply: (event) => durableIndex.apply(event),
    applyBatch: (events) => {
      if (failNextBatch) {
        failNextBatch = false;
        throw new Error("simulated index interruption");
      }
      return durableIndex.applyBatch(events);
    },
    rebuild: (events) => durableIndex.rebuild(events),
    get: (memoryId) => durableIndex.get(memoryId),
    findByOperation: (operationId) => durableIndex.findByOperation(operationId),
    list: (options) => durableIndex.list(options),
    search: (options) => durableIndex.search(options),
  };
  const controller = new MemoryController(store, flakyIndex, session.sessionId);
  assert.throws(() => controller.propose({
    operationId: "recovery:one",
    layer: "semantic",
    statement: "Legacy recovery claim",
    scope: "project:legacy",
    provenance: [{ sessionId: session.sessionId, eventId: session.event.eventId, sequence: 1 }],
    confidence: 1,
    sensitivity: "public",
  }, { actorId: "projector", autoAccept: true }), (error) => error.code === "MEMORY_INDEX_PENDING");
  assert.equal(store.read(session.sessionId).events.length, 3);
  const recovered = controller.propose({
    operationId: "recovery:one",
    layer: "semantic",
    statement: "Legacy recovery claim",
    scope: "project:legacy",
    provenance: [{ sessionId: session.sessionId, eventId: session.event.eventId, sequence: 1 }],
    confidence: 1,
    sensitivity: "public",
  }, { actorId: "projector", autoAccept: true });
  assert.equal(recovered.status, "accepted");
  assert.equal(store.read(session.sessionId).events.length, 3);
  durableIndex.close();
  await rm(root, { recursive: true, force: true });
});

test("quiet hours and attention budget govern proactive interruption; presence remains explicit runtime state", () => {
  const store = new InMemoryEventStore();
  const session = createSession(store, "ses_attention_test");
  const controller = new ContinuityController(store, session.sessionId, {
    clock: () => new Date("2026-07-22T13:00:00.000Z"),
  });
  controller.setAttentionPolicy({
    timezone: "Asia/Shanghai",
    quietStart: "22:00",
    quietEnd: "08:00",
    maxInterruptions: 1,
  }, "user");
  assert.equal(controller.canInterrupt().allowed, true);
  assert.equal(controller.requestAttention("A watched build failed").allowed, true);
  assert.match(controller.canInterrupt().reason, /exhausted/);
  controller.presence("watching", "Watching an authorized build", "2026-07-22T14:00:00.000Z");
  assert.deepEqual(store.load(session.sessionId).presence, {
    state: "watching",
    reason: "Watching an authorized build",
    wakeAt: "2026-07-22T14:00:00.000Z",
  });

  const quietSession = createSession(store, "ses_attention_quiet");
  const quiet = new ContinuityController(store, quietSession.sessionId, {
    clock: () => new Date("2026-07-22T14:30:00.000Z"),
  });
  quiet.setAttentionPolicy({ timezone: "Asia/Shanghai", quietStart: "22:00", quietEnd: "08:00", maxInterruptions: 2 }, "user");
  assert.match(quiet.requestAttention("Non-urgent update").reason, /quiet hours/);
  assert.equal(store.load(quietSession.sessionId).attentionPolicy.interruptions, 0);
});
