import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter, SessionSupervisor } from "@civaapple/qi-agent/loop";
import { SqliteEventStore } from "@civaapple/qi-node/storage";

test("SessionSupervisor parks a crashed running Action as indeterminate after SQLite restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-recovery-"));
  const path = join(root, "events.sqlite");
  const sessionId = "ses_recovery_001";
  const runId = "run_recovery_001";
  const stepId = "stp_recovery_001";
  const actionId = "act_recovery_001";
  const actor = { kind: "runtime", id: "test" };
  const store = new SqliteEventStore(path);
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Recovery" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "write" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append(
    "action.proposed",
    { runId, stepId, actionId, toolName: "write", effect: "write" },
    actor,
  );
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", { runId, stepId, actionId, leaseId: "lea_recovery_001" }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  store.close();

  const reopened = new SqliteEventStore(path);
  try {
    const before = reopened.read(sessionId).version;
    const supervisor = new SessionSupervisor(reopened);
    const recovery = supervisor.recover(sessionId);
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.reason, "indeterminate-effect");
    assert.equal(recovery.view.runs[runId].actions[actionId].status, "indeterminate");
    assert.equal(recovery.view.runs[runId].status, "parked");
    assert.match(
      recovery.view.runs[runId].terminal?.detail ?? "",
      /write: Process restarted after executor entry but before settlement/,
    );
    assert.equal(reopened.read(sessionId).version, before + 2);
    assert.equal(supervisor.recover(sessionId).recovered, false);
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionSupervisor cancels a granted Action that never entered its executor", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_recovery_002";
  const runId = "run_recovery_002";
  const stepId = "stp_recovery_002";
  const actionId = "act_recovery_002";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", {}, actor);
  writer.append("run.triggered", { runId, trigger: "user" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", { runId, stepId, actionId, toolName: "write", effect: "write" }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", { runId, stepId, actionId, leaseId: "lea_recovery_002" }, actor);

  const recovered = new SessionSupervisor(store).recover(sessionId);
  assert.equal(recovered.reason, "review");
  assert.equal(recovered.view.runs[runId].actions[actionId].status, "cancelled");
  assert.equal(recovered.view.runs[runId].actions[actionId].terminalDetail, "Process restarted before executor entry");
});
