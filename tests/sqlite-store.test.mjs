import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConcurrencyError, StateTransitionError, replaySession } from "@civaapple/qi-agent/kernel";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import { SqliteEventStore } from "@civaapple/qi-node/storage";

const fixtureUrl = new URL("../fixtures/golden/authority-denied.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")).map(parseSessionEvent);

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "qi-sqlite-test-"));
  const path = join(directory, "sessions.sqlite");
  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite store survives close and reconstructs the same Session view", async () => {
  await withDatabase((path) => {
    const expected = replaySession(fixture);
    const writer = new SqliteEventStore(path);
    writer.append("ses_golden_001", 0, fixture);
    writer.close();

    const reader = new SqliteEventStore(path);
    assert.deepEqual(reader.load("ses_golden_001"), expected);
    assert.deepEqual(reader.read("ses_golden_001", 7).events, fixture.slice(7));
    assert.deepEqual(reader.listSessions(), [{
      sessionId: "ses_golden_001",
      title: expected.title,
      version: fixture.length,
      updatedAt: fixture.at(-1).occurredAt,
    }]);
    reader.close();
  });
});

test("SQLite append uses optimistic concurrency after restart", async () => {
  await withDatabase((path) => {
    const first = new SqliteEventStore(path);
    first.append("ses_golden_001", 0, fixture);
    first.close();

    const second = new SqliteEventStore(path);
    assert.throws(
      () => second.append("ses_golden_001", 0, fixture),
      (error) => error instanceof ConcurrencyError && error.actualVersion === fixture.length,
    );
    assert.equal(second.read("ses_golden_001").version, fixture.length);
    second.close();
  });
});

test("SQLite incremental projection is exactly equal to cold replay and restart", async () => {
  await withDatabase((path) => {
    const store = new SqliteEventStore(path);
    let version = 0;
    for (const event of fixture) {
      const incremental = store.append("ses_golden_001", version, [event]);
      version += 1;
      assert.deepEqual(incremental, replaySession(fixture.slice(0, version)));
    }
    store.close();

    const restarted = new SqliteEventStore(path);
    assert.deepEqual(restarted.load("ses_golden_001"), replaySession(fixture));
    restarted.close();
  });
});

test("SQLite append rolls back the whole invalid batch", async () => {
  await withDatabase((path) => {
    const store = new SqliteEventStore(path);
    const invalidStart = {
      ...fixture[6],
      eventId: "evt_sqlite_invalid_007",
      sequence: 7,
      type: "action.started",
      actor: { kind: "runtime", id: "tool_runner" },
      data: { runId: "run_golden_001", stepId: "stp_golden_001", actionId: "act_golden_001" },
    };

    assert.throws(
      () => store.append("ses_golden_001", 0, [...fixture.slice(0, 6), invalidStart]),
      (error) => error instanceof StateTransitionError && error.code === "ACTION_NOT_GRANTED",
    );
    assert.equal(store.read("ses_golden_001").version, 0);
    store.close();
  });
});

test("SQLite store rejects stream and Session identity mismatch", async () => {
  await withDatabase((path) => {
    const store = new SqliteEventStore(path);
    assert.throws(
      () => store.append("ses_wrong_001", 0, fixture),
      (error) => error instanceof StateTransitionError && error.code === "STREAM_SESSION_MISMATCH",
    );
    assert.equal(store.read("ses_wrong_001").version, 0);
    store.close();
  });
});
