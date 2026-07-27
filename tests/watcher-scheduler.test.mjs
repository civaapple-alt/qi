import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryEventStore } from "@civaapple/qi-kernel";
import { EventWriter } from "@civaapple/qi-loop";
import { SessionEventTriggerSink, SqliteWatcherScheduler } from "@civaapple/qi-scheduler";

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-watch-test-"));
  try { await run(join(root, "watchers.sqlite")); } finally { await rm(root, { recursive: true, force: true }); }
}

test("A stopped watcher cannot emit any new Run", async () => {
  await temporary(async (path) => {
    const store = new InMemoryEventStore();
    new EventWriter(store, "ses_watch_001").append("session.created", {}, { kind: "user", id: "user" });
    const scheduler = new SqliteWatcherScheduler(path, new SessionEventTriggerSink(store));
    const watcher = scheduler.create({ sessionId: "ses_watch_001", mode: "timer", intervalMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    assert.equal(scheduler.stop(watcher.watcherId), true);
    assert.equal(await scheduler.tick(new Date("2026-01-01T00:00:01.000Z")), 0);
    assert.deepEqual(store.load("ses_watch_001").runOrder, []);
    scheduler.close();
  });
});

test("Watcher lifetime is hard-bounded and an external completion condition auto-closes it", async () => {
  await temporary(async (path) => {
    const calls = [];
    const scheduler = new SqliteWatcherScheduler(path, { async trigger(input) { calls.push(input); return input.runId; } }, { maximumLifetimeMs: 10_000 });
    assert.throws(() => scheduler.create({ sessionId: "ses_watch_001", mode: "timer", intervalMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:20.000Z" }), /maximum lifetime/);
    scheduler.registerCondition("pr-merged", async () => true);
    const watcher = scheduler.create({ sessionId: "ses_watch_001", mode: "timer", intervalMs: 1_000, conditionId: "pr-merged", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:10.000Z" });
    assert.equal(await scheduler.tick(new Date("2026-01-01T00:00:01.000Z")), 0);
    assert.equal(scheduler.get(watcher.watcherId).state, "completed");
    assert.deepEqual(calls, []);
    scheduler.close();
  });
});

test("Event watcher delivery is persistent and idempotent by external event ID", async () => {
  await temporary(async (path) => {
    const calls = [];
    let scheduler = new SqliteWatcherScheduler(path, { async trigger(input) { calls.push(input); return input.runId; } });
    scheduler.create({ watcherId: "wat_event_001", sessionId: "ses_watch_001", mode: "event", eventKey: "pull-request", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    scheduler.close();
    scheduler = new SqliteWatcherScheduler(path, { async trigger(input) { calls.push(input); return input.runId; } });
    assert.equal(await scheduler.notify("pull-request", "evt-external-1", { state: "open" }, new Date("2026-01-01T01:00:00.000Z")), 1);
    assert.equal(await scheduler.notify("pull-request", "evt-external-1", { state: "open" }, new Date("2026-01-01T01:01:00.000Z")), 0);
    assert.equal(calls.length, 1);
    scheduler.close();
  });
});

test("Attention gate suppresses proactive triggers during disallowed time", async () => {
  await temporary(async (path) => {
    let calls = 0;
    const scheduler = new SqliteWatcherScheduler(path, { async trigger(input) { calls += 1; return input.runId; } }, { attention: { allows: () => false } });
    scheduler.create({ sessionId: "ses_watch_001", mode: "timer", intervalMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    assert.equal(await scheduler.tick(new Date("2026-01-01T00:00:01.000Z")), 0);
    assert.equal(calls, 0);
    scheduler.close();
  });
});

test("Crash after Run append replays the same stable Run ID instead of duplicating", async () => {
  await temporary(async (path) => {
    const store = new InMemoryEventStore();
    new EventWriter(store, "ses_watch_crash").append("session.created", {}, { kind: "user", id: "user" });
    const durableSink = new SessionEventTriggerSink(store);
    let first = true;
    let scheduler = new SqliteWatcherScheduler(path, {
      async trigger(input) {
        const runId = await durableSink.trigger(input);
        if (first) { first = false; throw new Error("crash after append"); }
        return runId;
      },
    });
    scheduler.create({ watcherId: "wat_crash_001", sessionId: "ses_watch_crash", mode: "timer", intervalMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    await assert.rejects(scheduler.tick(new Date("2026-01-01T00:00:01.000Z")), /crash after append/);
    scheduler.close();
    scheduler = new SqliteWatcherScheduler(path, durableSink);
    assert.equal(await scheduler.recoverPending(new Date("2026-01-01T00:00:02.000Z")), 1);
    assert.equal(store.load("ses_watch_crash").runOrder.length, 1);
    scheduler.close();
  });
});

test("Stopping an in-flight watcher aborts delivery before the TriggerSink commits", async () => {
  await temporary(async (path) => {
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const committed = [];
    const scheduler = new SqliteWatcherScheduler(path, {
      async trigger(input) {
        entered();
        await barrier;
        input.signal.throwIfAborted();
        committed.push(input.runId);
        return input.runId;
      },
    });
    const watcher = scheduler.create({ watcherId: "wat_inflight_001", sessionId: "ses_watch_001", mode: "timer", intervalMs: 1_000, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    const ticking = scheduler.tick(new Date("2026-01-01T00:00:01.000Z"));
    await enteredPromise;
    assert.equal(scheduler.stop(watcher.watcherId), true);
    release();
    await assert.rejects(ticking, /stopped/);
    assert.deepEqual(committed, []);
    scheduler.close();
  });
});
