import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InMemoryEventStore,
  applySessionEvent,
  isBootstrapSessionTitle,
  replaySession,
  sessionTitleFromUserInput,
  SESSION_TITLE_MAX_CHARS,
} from "@civaapple/qi-agent/kernel";
import { SqliteEventStore } from "@civaapple/qi-node/storage";
import { EventWriter } from "@civaapple/qi-agent/loop";

test("sessionTitleFromUserInput keeps the first line and truncates long text", () => {
  assert.equal(sessionTitleFromUserInput("  hello   world  \nsecond"), "hello world");
  assert.equal(sessionTitleFromUserInput(""), "");
  assert.equal(sessionTitleFromUserInput("\nonly second line"), "");
  const long = "x".repeat(SESSION_TITLE_MAX_CHARS + 20);
  const titled = sessionTitleFromUserInput(long);
  assert.equal(titled.length, SESSION_TITLE_MAX_CHARS);
  assert.equal(titled.endsWith("…"), true);
  assert.equal(sessionTitleFromUserInput("短标题"), "短标题");
  assert.equal(isBootstrapSessionTitle("Qi TUI"), true);
  assert.equal(isBootstrapSessionTitle("Deployment boundary"), false);
});

test("session.retitled updates the Session title durably", () => {
  let view = applySessionEvent(undefined, {
    schemaVersion: 1,
    eventId: "evt_title_r001",
    sessionId: "ses_title_r001",
    sequence: 1,
    occurredAt: "2026-07-30T10:00:00.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "session.created",
    data: { title: "Qi TUI" },
  });
  view = applySessionEvent(view, {
    schemaVersion: 1,
    eventId: "evt_title_r002",
    sessionId: "ses_title_r001",
    sequence: 2,
    occurredAt: "2026-07-30T10:00:01.000Z",
    actor: { kind: "user", id: "user" },
    type: "session.retitled",
    data: { title: "Auth refactor", previousTitle: "Qi TUI", reason: "User renamed Session" },
  });
  assert.equal(view.title, "Auth refactor");
  assert.throws(
    () => applySessionEvent(view, {
      schemaVersion: 1,
      eventId: "evt_title_r003",
      sessionId: "ses_title_r001",
      sequence: 3,
      occurredAt: "2026-07-30T10:00:02.000Z",
      actor: { kind: "user", id: "user" },
      type: "session.retitled",
      data: { title: "Auth refactor" },
    }),
    /already set to that value|SESSION_TITLE_UNCHANGED/,
  );
});

test("Kernel replaces bootstrap Session titles from the first user message only", () => {
  let view = applySessionEvent(undefined, {
    schemaVersion: 1,
    eventId: "evt_title_a001",
    sessionId: "ses_title_a001",
    sequence: 1,
    occurredAt: "2026-07-30T10:00:00.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "session.created",
    data: { title: "Qi TUI" },
  });
  view = applySessionEvent(view, {
    schemaVersion: 1,
    eventId: "evt_title_a002",
    sessionId: "ses_title_a001",
    sequence: 2,
    occurredAt: "2026-07-30T10:00:01.000Z",
    actor: { kind: "user", id: "user" },
    type: "run.triggered",
    data: {
      runId: "run_title_a001",
      trigger: "user",
      input: `${"请帮我调试本地鉴权服务，".repeat(10)}\n第二行不应进入标题`,
    },
  });
  assert.equal(view.title?.endsWith("…"), true);
  assert.ok((view.title?.length ?? 0) <= SESSION_TITLE_MAX_CHARS);
  assert.doesNotMatch(view.title ?? "", /第二行/);
  const titled = view.title;

  view = applySessionEvent(view, {
    schemaVersion: 1,
    eventId: "evt_title_a003",
    sessionId: "ses_title_a001",
    sequence: 3,
    occurredAt: "2026-07-30T10:00:02.000Z",
    actor: { kind: "runtime", id: "qi" },
    type: "run.cancelled",
    data: { runId: "run_title_a001", reason: "test" },
  });
  view = applySessionEvent(view, {
    schemaVersion: 1,
    eventId: "evt_title_a004",
    sessionId: "ses_title_a001",
    sequence: 4,
    occurredAt: "2026-07-30T10:00:03.000Z",
    actor: { kind: "user", id: "user" },
    type: "run.triggered",
    data: { runId: "run_title_a002", trigger: "user", input: "继续" },
  });
  assert.equal(view.title, titled, "later user messages must not rename the Session");
});

test("Kernel keeps explicit non-bootstrap Session titles", () => {
  const view = replaySession([
    {
      schemaVersion: 1,
      eventId: "evt_title_b001",
      sessionId: "ses_title_b001",
      sequence: 1,
      occurredAt: "2026-07-30T10:00:00.000Z",
      actor: { kind: "runtime", id: "qi" },
      type: "session.created",
      data: { title: "Deployment boundary" },
    },
    {
      schemaVersion: 1,
      eventId: "evt_title_b002",
      sessionId: "ses_title_b001",
      sequence: 2,
      occurredAt: "2026-07-30T10:00:01.000Z",
      actor: { kind: "user", id: "user" },
      type: "run.triggered",
      data: { runId: "run_title_b001", trigger: "user", input: "Deploy the current branch" },
    },
  ]);
  assert.equal(view.title, "Deployment boundary");
});

test("SQLite listSessions uses the projected title after the first user message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qi-session-title-"));
  const path = join(directory, "sessions.sqlite");
  const store = new SqliteEventStore(path);
  try {
    const writer = new EventWriter(store, "ses_title_c001");
    writer.append("session.created", { title: "Qi TUI" }, { kind: "runtime", id: "qi" });
    writer.append(
      "run.triggered",
      { runId: "run_title_c001", trigger: "user", input: "实现 notebook 本地鉴权" },
      { kind: "user", id: "user" },
    );
    assert.deepEqual(store.listSessions(), [{
      sessionId: "ses_title_c001",
      title: "实现 notebook 本地鉴权",
      version: 2,
      updatedAt: store.read("ses_title_c001").events.at(-1)?.occurredAt,
    }]);

    const memory = new InMemoryEventStore();
    const memoryWriter = new EventWriter(memory, "ses_title_d001");
    memoryWriter.append("session.created", { title: "Qi TUI" }, { kind: "runtime", id: "qi" });
    memoryWriter.append(
      "run.triggered",
      { runId: "run_title_d001", trigger: "user", input: "实现 notebook 本地鉴权" },
      { kind: "user", id: "user" },
    );
    assert.equal(memory.listSessions()[0]?.title, "实现 notebook 本地鉴权");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
