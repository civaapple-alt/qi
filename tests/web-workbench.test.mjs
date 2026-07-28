import assert from "node:assert/strict";
import test from "node:test";
import { QiWebServer, projectWebSession } from "@civaapple/qi-web";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { SessionEventHub } from "@civaapple/qi-node/stream";

test("Web workbench serves real Session projections, history and committed live events without demo data", async () => {
  const store = new InMemoryEventStore();
  const hub = new SessionEventHub();
  const sessionId = "ses_web_workbench";
  const seed = new EventWriter(store, sessionId);
  seed.append("session.created", { title: "Real project" }, { kind: "runtime", id: "test" });
  const server = new QiWebServer({ eventStore: store, eventHub: hub });
  const address = await server.listen();
  try {
    const page = await fetch(address.url).then((response) => response.text());
    assert.match(page, /world workbench/);
    assert.match(page, /Run Narrative/);
    assert.match(page, /does not synthesize demo state/);
    const stylesheet = await fetch(`${address.url}/style.css`).then((response) => response.text());
    assert.match(stylesheet, /\[hidden\]\{display:none!important\}/);
    const application = await fetch(`${address.url}/app.js`).then((response) => response.text());
    assert.match(application, /model requested tool batch/);
    assert.match(application, /data-run-id/);
    assert.match(application, /\/workbench/);
    assert.match(application, /\/api\/meta/);
    assert.match(application, /withProject/);
    assert.match(application, /formatClock/);
    assert.doesNotMatch(application, /narrative\.runs\.slice\(\)\.reverse\(\)/);

    const meta = await fetch(`${address.url}/api/meta`).then((response) => response.json());
    assert.equal(meta.mode, "single");
    const sessions = await fetch(`${address.url}/api/sessions`).then((response) => response.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sessionId);
    assert.equal(sessions[0].title, "Real project");
    assert.equal(sessions[0].version, 1);

    const response = await fetch(`${address.url}/api/session/${sessionId}`);
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.title, "Real project");
    assert.equal(view.version, 1);
    assert.deepEqual(view.memories, {});

    const history = await fetch(`${address.url}/api/session/${sessionId}/history`).then((item) => item.json());
    assert.deepEqual(history.map((event) => event.type), ["session.created"]);
    const workbench = await fetch(`${address.url}/api/session/${sessionId}/workbench`).then((item) => item.json());
    assert.equal(workbench.narrative.sessionId, sessionId);
    assert.deepEqual(workbench.narrative.runs, []);
    assert.equal(workbench.events.length, 1);
    assert.equal((await fetch(`${address.url}/api/session/ses_missing_001`)).status, 404);

    const controller = new AbortController();
    const streamResponse = await fetch(
      `${address.url}/api/session/${sessionId}/events?after=1`,
      { signal: controller.signal },
    );
    assert.match(streamResponse.headers.get("content-type"), /text\/event-stream/);
    const writer = new EventWriter(store, sessionId, undefined, (event) => hub.publish(event));
    writer.append(
      "presence.changed",
      { state: "watching", reason: "Waiting for a real build" },
      { kind: "runtime", id: "continuity_controller" },
    );
    const reader = streamResponse.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /event: presence\.changed/);
    assert.match(text, /Waiting for a real build/);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await server.close();
  }
});

test("Web narrative joins Run, Step and Action events without synthesizing evidence", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_web_narrative";
  const runId = "run_web_narrative";
  const stepId = "stp_web_narrative";
  const actionId = "act_web_narrative";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Narrative project" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "Fix the total calculation" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("context.compiled", {
    runId,
    stepId,
    includedBlockIds: ["user-task"],
    omittedBlockIds: [],
    estimatedTokens: 320,
    budgetTokens: 8_000,
  }, actor);
  writer.append("model.completed", {
    runId,
    stepId,
    requestId: "req_web_narrative",
    provider: "test",
    model: "deterministic",
    finishReason: "actions",
    text: "I will update the implementation.",
    actionCalls: [{ callId: "call_web_narrative", name: "edit", input: { path: "src/total.ts" } }],
  }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId,
    toolName: "edit",
    input: { path: "src/total.ts", oldText: "return 0", newText: "return total" },
    resources: ["workspace:src/total.ts"],
    effect: "write",
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", { runId, stepId, actionId, leaseId: "lea_web_narrative" }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId,
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        path: "src/total.ts",
        replacements: 1,
        diff: "--- a/src/total.ts\n+++ b/src/total.ts\n@@\n-return 0\n+return total",
      }),
    }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  const narrative = projectWebSession(view, store.read(sessionId).events);
  const run = narrative.runs[0];
  assert.equal(run.input, "Fix the total calculation");
  assert.equal(run.displayStatus, "responded");
  assert.ok(run.startedAt);
  assert.match(run.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(run.summary.tools, ["edit"]);
  assert.deepEqual(run.summary.effects, ["write"]);
  assert.equal(run.summary.completedActions, 1);
  const step = run.steps[0];
  assert.equal(step.status, "settled");
  assert.equal(step.finishReason, "action-requested");
  assert.equal(step.context.estimatedTokens, 320);
  const action = step.actions[0];
  assert.equal(action.toolName, "edit");
  assert.equal(action.target, "src/total.ts");
  assert.equal(action.resultSummary, "1 replacement(s)");
  assert.match(action.diff, /\+return total/);
  assert.ok(action.milestones.proposed < action.milestones.started);
  assert.ok(action.milestones.started < action.milestones.terminal);
  assert.deepEqual(view.evidence, {});
  assert.deepEqual(view.memories, {});
});
