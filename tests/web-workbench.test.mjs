import assert from "node:assert/strict";
import test from "node:test";
import { QiWebServer, projectWebSession } from "@civaapple/qi-web";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter, HumanControlService } from "@civaapple/qi-agent/loop";
import { SessionEventHub } from "@civaapple/qi-node/stream";
import { createId } from "@civaapple/qi-protocol";

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
    assert.match(application, /function renderThinking/);
    assert.match(application, /File change ·/);
    assert.match(application, /Working on /);
    assert.match(application, /Git workspace change/);
    assert.match(application, /run\.displayTitle/);
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
    assert.equal(workbench.memory.userIndexAvailable, false);
    assert.deepEqual(workbench.memory.usage, []);
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
    reasoning: "Need to fix the total helper.\nPrefer an edit over a rewrite.\nKeep the public API stable.",
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
  assert.equal(run.displayTitle, "Fix the total calculation");
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
  assert.match(step.modelReasoning, /Prefer an edit over a rewrite/);
  const action = step.actions[0];
  assert.equal(action.toolName, "edit");
  assert.equal(action.target, "src/total.ts");
  assert.equal(action.resultSummary, "1 replacement(s)");
  assert.match(action.diff, /\+return total/);
  assert.equal(action.gitWorkspaceChange, false);
  assert.ok(action.milestones.proposed < action.milestones.started);
  assert.ok(action.milestones.started < action.milestones.terminal);
  assert.deepEqual(view.evidence, {});
  assert.deepEqual(view.memories, {});
});

test("Web narrative shortens Accepted Plan titles and projects Thinking, Work Plan, and tool cards", () => {
  const store = new InMemoryEventStore();
  const sessionId = createId("ses");
  const control = new HumanControlService({ eventStore: store });
  control.ensureSession(sessionId, "Formal narrative", "plan");
  const planId = createId("pln");
  const markdown = [
    "# Feature plan",
    "",
    "Implement the accepted design.",
    "",
    ...Array.from({ length: 210 }, (_, index) => `${index + 1}. Bounded step ${index + 1}.`),
  ].join("\n");
  control.recordPlanRevision(sessionId, {
    planId,
    format: "formal_markdown",
    title: "Feature plan",
    overview: "Implement the accepted design.",
    markdown,
    artifactRef: `artifact://${"d".repeat(64)}`,
    sha256: "d".repeat(64),
    path: "/tmp/feature-plan.md",
  });
  const accepted = control.acceptPlanAndStartFirstRun(sessionId);
  assert.match(accepted.input, /<accepted-plan/);

  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  const runId = accepted.runId;
  const stepId = "stp_web_plan01";
  const editId = "act_web_edit01";
  const planActionId = "act_web_todo01";
  const shellId = "act_web_shell1";
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("model.completed", {
    runId,
    stepId,
    requestId: "req_web_plan",
    provider: "test",
    model: "deterministic",
    finishReason: "actions",
    text: "Executing the Formal Plan.",
    reasoning: "line one\nline two\nline three\nline four",
    actionCalls: [
      { callId: "call_todo", name: "update_plan", input: { plan: [] } },
      { callId: "call_edit", name: "edit", input: { path: "src/app.ts" } },
      { callId: "call_shell", name: "shell", input: { command: "npm", args: ["test"] } },
    ],
  }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId: planActionId,
    toolName: "update_plan",
    input: {
      explanation: "Track the accepted plan.",
      plan: [
        { workItemId: "wit_protocol", step: "Extend protocol", status: "completed" },
        { workItemId: "wit_runtime0", step: "Wire runtime", status: "in_progress" },
        { workItemId: "wit_verify00", step: "Verify behavior", status: "pending" },
      ],
    },
    resources: ["work-plan:current"],
    effect: "write",
  }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId: editId,
    toolName: "edit",
    input: { path: "src/app.ts", oldText: "a", newText: "b" },
    resources: ["workspace:src/app.ts"],
    effect: "write",
  }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId: shellId,
    toolName: "shell",
    input: { command: "npm", args: ["test"] },
    resources: ["host-process:npm"],
    effect: "execute",
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);

  for (const actionId of [planActionId, editId, shellId]) {
    writer.append("authority.requested", { runId, stepId, actionId }, actor);
    writer.append("authority.granted", { runId, stepId, actionId, leaseId: `lea_${actionId.slice(-8)}` }, actor);
    writer.append("action.started", { runId, stepId, actionId }, actor);
  }

  writer.append("work.plan.updated", {
    workPlanId: "wpl_web_plan01",
    revision: 1,
    runId,
    stepId,
    actionId: planActionId,
    explanation: "Track the accepted plan.",
    items: [
      { workItemId: "wit_protocol", step: "Extend protocol", status: "completed" },
      { workItemId: "wit_runtime0", step: "Wire runtime", status: "in_progress" },
      { workItemId: "wit_verify00", step: "Verify behavior", status: "pending" },
    ],
  }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId: planActionId,
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        explanation: "Track the accepted plan.",
        plan: [
          { workItemId: "wit_protocol", step: "Extend protocol", status: "completed" },
          { workItemId: "wit_runtime0", step: "Wire runtime", status: "in_progress" },
          { workItemId: "wit_verify00", step: "Verify behavior", status: "pending" },
        ],
      }),
    }],
  }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId: editId,
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        path: "src/app.ts",
        replacements: 1,
        diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-a\n+b",
      }),
    }],
  }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId: shellId,
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        exitCode: 0,
        stdout: "setup\ncompile\nok",
        stderr: "",
        workspaceChange: {
          changed: true,
          diff: " M src/app.ts\n",
        },
      }),
    }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  const narrative = projectWebSession(view, store.read(sessionId).events);
  const run = narrative.runs[0];
  assert.equal(run.displayTitle, "Accepted Plan · Feature plan · rev 1");
  assert.notEqual(run.displayTitle, run.input);
  assert.ok(run.formalPlan);
  assert.equal(run.formalPlan.title, "Feature plan");
  assert.equal(run.formalPlan.path, "/tmp/feature-plan.md");
  assert.equal(run.formalPlan.previewCollapsed, true);
  assert.match(run.formalPlan.markdownPreview, /1\. Bounded step 1/);
  assert.doesNotMatch(run.formalPlan.markdownPreview, /210\. Bounded step 210/);
  assert.ok(run.workPlan);
  assert.equal(run.workPlan.items.length, 3);
  assert.match(run.steps[0].modelReasoning, /line four/);

  const [todo, edit, shell] = run.steps[0].actions;
  assert.equal(todo.toolName, "update_plan");
  assert.equal(todo.workPlanItems.length, 3);
  assert.equal(todo.workPlanItems[1].status, "in_progress");
  assert.equal(todo.workPlanExplanation, "Track the accepted plan.");
  assert.equal(edit.toolName, "edit");
  assert.match(edit.diff, /\+b/);
  assert.equal(edit.gitWorkspaceChange, false);
  assert.equal(shell.toolName, "shell");
  assert.equal(shell.process.command, "npm test");
  assert.equal(shell.process.exitCode, 0);
  assert.equal(shell.process.workspaceChanged, true);
  assert.equal(shell.gitWorkspaceChange, true);
  assert.match(shell.diff, /src\/app\.ts/);
});

test("Web workbench renders durable ProcessTasks and subscribes to their lifecycle", async () => {
  const store = new InMemoryEventStore();
  const hub = new SessionEventHub();
  const sessionId = "ses_web_tasks";
  const taskId = "tsk_web_server";
  const writer = new EventWriter(store, sessionId);
  const actor = { kind: "runtime", id: "test" };
  writer.append("session.created", { title: "Background server" }, actor);
  writer.append("run.triggered", { runId: "run_web_tasks", trigger: "user", input: "Start the dev server" }, actor);
  writer.append("run.started", { runId: "run_web_tasks" }, actor);
  writer.append("step.started", { runId: "run_web_tasks", stepId: "stp_web_tasks" }, actor);
  writer.append("model.completed", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    requestId: "req_web_tasks",
    provider: "test",
    model: "deterministic",
    finishReason: "actions",
    text: "",
    actionCalls: [{
      callId: "call_web_tasks",
      name: "task",
      input: { command: "npm", args: ["run", "dev"], workdir: "web-app" },
    }],
  }, actor);
  writer.append("action.proposed", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    actionId: "act_web_tasks",
    toolName: "task",
    input: { command: "npm", args: ["run", "dev"], workdir: "web-app" },
    resources: ["host-process:npm", "host-workspace:web-app", "background-task:process"],
    effect: "execute",
  }, actor);
  writer.append("step.completed", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    finishReason: "action-requested",
  }, actor);
  writer.append("authority.requested", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    actionId: "act_web_tasks",
  }, actor);
  writer.append("authority.granted", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    actionId: "act_web_tasks",
    leaseId: "lea_web_tasks",
  }, actor);
  writer.append("action.started", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    actionId: "act_web_tasks",
  }, actor);
  writer.append("task.started", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    actionId: "act_web_tasks",
    taskId,
    command: "npm",
    args: ["run", "dev"],
    workdir: "web-app",
    pid: 4317,
    expiresAt: "2099-01-01T00:00:00.000Z",
    logRef: "process-task://tsk_web_server/log",
  }, actor);
  writer.append("action.completed", {
    runId: "run_web_tasks",
    stepId: "stp_web_tasks",
    actionId: "act_web_tasks",
    modelOutput: [{ type: "text", text: JSON.stringify({ taskId, status: "running" }) }],
  }, actor);
  writer.append("run.completed", {
    runId: "run_web_tasks",
    completionKind: "response",
    evaluationIds: [],
  }, actor);

  const server = new QiWebServer({ eventStore: store, eventHub: hub });
  const address = await server.listen();
  try {
    const page = await fetch(address.url).then((response) => response.text());
    assert.match(page, /Background ProcessTasks/);
    const application = await fetch(`${address.url}/app.js`).then((response) => response.text());
    assert.match(application, /function renderTasks/);
    for (const eventType of ["task.started", "task.stop.requested", "task.exited", "task.lost"]) {
      assert.match(application, new RegExp(eventType.replace(".", "\\.")));
    }

    const workbench = await fetch(`${address.url}/api/session/${sessionId}/workbench`).then((response) => response.json());
    assert.deepEqual(workbench.view.taskOrder, [taskId]);
    assert.equal(workbench.view.tasks[taskId].status, "running");
    assert.equal(workbench.view.tasks[taskId].command, "npm");
    assert.deepEqual(workbench.view.tasks[taskId].args, ["run", "dev"]);
  } finally {
    await server.close();
  }
});
