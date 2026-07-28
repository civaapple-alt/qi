import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.deepEqual(secondController.retrieve({ scopes: ["project:fastai"], query: "project" }).map((claim) => claim.memoryId), [corrected.memoryId]);
  assert.equal(secondController.retrieve({ scopes: ["project:fastai"], query: "pnpm" }).length, 0);

  secondController.forget(corrected.memoryId, "User requested deletion", "user");
  assert.equal(secondController.retrieve({ scopes: ["project:fastai"], query: "project" }).length, 0);
  assert.equal(store.load(second.sessionId).memories[corrected.memoryId].status, "forgotten");
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
