import assert from "node:assert/strict";
import test from "node:test";
import {
  QiWebServer,
  classifyDenial,
  classifyFailure,
  guardLayersForTool,
  projectWebSession,
} from "@civaapple/qi-web";
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
    assert.match(application, /function omittedSummary/);
    assert.match(application, /function skillLabel/);
    assert.match(application, /artifact-store write/);
    assert.match(application, /Todo status is navigation only/);
    assert.match(application, /function renderAuthority/);
    assert.match(application, /function renderSessionAuthority/);
    assert.match(application, /function renderFailureBanner/);
    assert.match(application, /function renderGuardLayers/);
    assert.match(application, /function renderApprovalCard/);
    assert.match(application, /function renderRunEnvironment/);
    assert.match(application, /SESSION AUTHORITY/);
    assert.match(application, /Policy trace/);
    assert.match(application, /Process isolation/);
    assert.match(application, /authority\.approval\.decided/);
    assert.match(application, /run\.environment\.disclosed/);
    assert.match(application, /workspace\.mount\.added/);
    assert.match(application, /session\.mode\.changed/);
    assert.doesNotMatch(application, /narrative\.runs\.slice\(\)\.reverse\(\)/);

    const meta = await fetch(`${address.url}/api/meta`).then((response) => response.json());
    assert.equal(meta.mode, "single");
    const childSessionId = "ses_web_child_delegated";
    new EventWriter(store, childSessionId).append(
      "session.created",
      { title: "Delegated: Map login paths" },
      { kind: "runtime", id: "coordinator" },
    );
    const sessions = await fetch(`${address.url}/api/sessions`).then((response) => response.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sessionId);
    assert.equal(sessions[0].title, "Real project");
    assert.equal(sessions[0].version, 1);
    assert.equal(
      (await fetch(`${address.url}/api/session/${childSessionId}`)).status,
      200,
      "Delegated child Sessions remain loadable by ID",
    );

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
    assert.equal(workbench.eventCount, 1);
    assert.equal(workbench.events, undefined);
    assert.equal(workbench.memory.userIndexAvailable, false);
    assert.deepEqual(workbench.memory.usage, []);
    assert.match(application, /ensureAuditEvents/);
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
    includedBlockIds: ["user-task", "skill:active:workspace:review-code:0123456789abcdef"],
    omittedBlockIds: ["history:omitted:run_prior"],
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
  assert.deepEqual(run.skills, [{ name: "review-code", scope: "workspace" }]);
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
  assert.deepEqual(step.context.omittedBlockIds, ["history:omitted:run_prior"]);
  assert.match(step.modelReasoning, /Prefer an edit over a rewrite/);
  const action = step.actions[0];
  assert.equal(action.toolName, "edit");
  assert.equal(action.target, "src/total.ts");
  assert.equal(action.resultSummary, "1 replacement(s)");
  assert.match(action.diff, /\+return total/);
  assert.equal(action.gitWorkspaceChange, false);
  assert.equal(action.leaseId, "lea_web_narrative");
  assert.equal(action.denialCategory, undefined);
  assert.ok(action.milestones.proposed < action.milestones.started);
  assert.ok(action.milestones.started < action.milestones.terminal);
  assert.equal(narrative.mode, "agent");
  assert.deepEqual(narrative.mounts, []);
  assert.deepEqual(narrative.sensitivePathGrants, []);
  assert.deepEqual(view.evidence, {});
  assert.deepEqual(view.memories, {});
});

test("Web projects Session authority facts and authority denials without inventing approval UI", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_web_authority";
  const runId = "run_web_authority";
  const stepId = "stp_web_authority";
  const grantedId = "act_web_auth_ok";
  const deniedId = "act_web_auth_deny";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Authority audit", mode: "agent" }, actor);
  writer.append(
    "workspace.mount.added",
    {
      mountId: "docs",
      path: "D:/share/docs",
      mode: "read",
      source: "grant",
    },
    actor,
  );
  writer.append(
    "workspace.sensitive_path.granted",
    { path: "secrets/local.env", source: "grant" },
    actor,
  );
  writer.append("run.triggered", { runId, trigger: "user", input: "touch secrets" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId: grantedId,
    toolName: "read",
    input: { path: "README.md" },
    resources: ["workspace:README.md"],
    effect: "read",
  }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId: deniedId,
    toolName: "write",
    input: { path: "out.txt", content: "x" },
    resources: ["workspace:out.txt"],
    effect: "write",
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId: grantedId }, actor);
  writer.append("authority.granted", {
    runId,
    stepId,
    actionId: grantedId,
    leaseId: "lea_read_workspace",
    policyTrace: [
      { leaseId: "lea_read_workspace", matched: true, reason: "workspace read lease" },
    ],
  }, actor);
  writer.append("action.started", { runId, stepId, actionId: grantedId }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId: grantedId,
    modelOutput: [{ type: "text", text: JSON.stringify({ path: "README.md", content: "# ok" }) }],
  }, actor);
  writer.append("authority.requested", { runId, stepId, actionId: deniedId }, actor);
  writer.append("authority.denied", {
    runId,
    stepId,
    actionId: deniedId,
    reason: "Manual approval required for write (write); no interactive gate available",
    policyTrace: [
      {
        leaseId: "lea_approval_policy",
        matched: false,
        reason: "manual-ask: Manual approval required",
      },
    ],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  assert.equal(view.mode, "agent");
  assert.equal(view.mounts.docs?.path, "D:/share/docs");
  assert.ok(view.sensitivePathGrants["secrets/local.env"]);

  const narrative = projectWebSession(view, store.read(sessionId).events);
  assert.equal(narrative.mode, "agent");
  assert.equal(narrative.mounts.length, 1);
  assert.equal(narrative.mounts[0].mountId, "docs");
  assert.equal(narrative.mounts[0].source, "grant");
  assert.equal(narrative.sensitivePathGrants.length, 1);
  assert.equal(narrative.sensitivePathGrants[0].path, "secrets/local.env");

  const run = narrative.runs[0];
  assert.equal(run.summary.deniedActions, 1);
  assert.equal(run.summary.completedActions, 1);
  const actions = run.steps[0].actions;
  const granted = actions.find((action) => action.actionId === grantedId);
  const denied = actions.find((action) => action.actionId === deniedId);
  assert.ok(granted);
  assert.ok(denied);
  assert.equal(granted.leaseId, "lea_read_workspace");
  assert.equal(granted.policyTrace?.[0]?.matched, true);
  assert.equal(denied.status, "denied");
  assert.match(denied.terminalDetail ?? "", /Manual approval required/);
  assert.equal(denied.denialCategory, "approval");
  assert.equal(denied.policyTrace?.[0]?.leaseId, "lea_approval_policy");
  assert.equal(denied.milestones.authorityGranted, undefined);
  assert.ok(denied.milestones.terminal);
  assert.deepEqual(granted.guardLayers, ["capability", "path-guard"]);
  assert.deepEqual(denied.guardLayers, ["capability", "path-guard"]);
  assert.equal(run.summary.isolationFailures, 0);
});

test("Web classifies process isolation failures and dual-layer guard models", () => {
  assert.deepEqual(guardLayersForTool("shell"), ["capability", "path-guard", "process-sandbox"]);
  assert.deepEqual(guardLayersForTool("edit"), ["capability", "path-guard"]);
  assert.equal(
    classifyDenial("User denied write (write)", [{ leaseId: "lea_approval_policy", matched: false, reason: "user_deny" }]),
    "user_deny",
  );
  assert.equal(
    classifyDenial("Path is outside the Workspace and mounts", undefined, "PATH_GRANT_REQUIRED"),
    "path",
  );
  assert.equal(
    classifyFailure({
      toolName: "script",
      errorCode: "SHELL_PROFILE_START_FAILED",
      resultSummary: "Could not start shell profile bash: spawn EINVAL (check sandbox/srt wrap)",
    }),
    "isolation",
  );
  assert.equal(
    classifyFailure({
      toolName: "shell",
      errorCode: "SHELL_PROFILE_EXIT_NONZERO",
      process: {
        command: "cat /etc/shadow",
        exitCode: 1,
        timedOut: false,
        stdout: undefined,
        stderr: "Operation not permitted",
        workspaceChanged: false,
      },
    }),
    "isolation",
  );
  assert.equal(
    classifyFailure({
      toolName: "write",
      errorCode: "SENSITIVE_PATH_GRANT_REQUIRED",
      result: { message: "Sensitive path requires an explicit human grant" },
    }),
    "sensitive_path",
  );
  assert.equal(
    classifyFailure({
      toolName: "script",
      errorCode: "SHELL_PROFILE_TIMEOUT",
      process: { command: "sleep", exitCode: undefined, timedOut: true, stdout: undefined, stderr: undefined, workspaceChanged: false },
    }),
    "timeout",
  );

  const store = new InMemoryEventStore();
  const sessionId = "ses_web_isolation";
  const runId = "run_web_isolation";
  const stepId = "stp_web_isolation";
  const actionId = "act_web_isolation";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Isolation failure" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "run blocked cmd" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId,
    toolName: "shell",
    input: { command: "npm", args: ["test"] },
    resources: ["host-process:npm"],
    effect: "execute",
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", {
    runId,
    stepId,
    actionId,
    leaseId: "lea_shell",
    policyTrace: [{ leaseId: "lea_shell", matched: true, reason: "execute lease" }],
  }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  writer.append("action.failed", {
    runId,
    stepId,
    actionId,
    errorCode: "SHELL_PROFILE_START_FAILED",
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        code: "SHELL_PROFILE_START_FAILED",
        message: "Could not start shell profile direct: spawn EPERM under srt-sandbox",
        profile: "direct",
      }),
    }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  const narrative = projectWebSession(view, store.read(sessionId).events);
  const action = narrative.runs[0].steps[0].actions[0];
  assert.equal(action.status, "failed");
  assert.equal(action.failureCategory, "isolation");
  assert.deepEqual(action.guardLayers, ["capability", "path-guard", "process-sandbox"]);
  assert.equal(narrative.runs[0].summary.isolationFailures, 1);
  assert.equal(action.leaseId, "lea_shell");
});

test("Web projects run.environment.disclosed and authority.approval.decided (ADR-0042)", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_web_env_approval";
  const runId = "run_web_env_approval";
  const stepId = "stp_web_env_approval";
  const actionId = "act_web_env_approval";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Env disclosure" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "write under manual" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("run.environment.disclosed", {
    runId,
    permissionMode: "manual",
    sessionMode: "agent",
    sandbox: {
      backend: "srt-windows",
      strength: "full",
      status: "active",
      wraps: ["shell", "script", "verify"],
      reason: "srt-win smoke ok",
    },
  }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId,
    toolName: "write",
    input: { path: "out.txt", content: "x" },
    resources: ["workspace:out.txt"],
    effect: "write",
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.approval.decided", {
    runId,
    stepId,
    actionId,
    decision: "allow",
    scope: "session",
    source: "interactive",
    pattern: {
      tool: "write",
      effect: "write",
      resourceClass: "workspace:file:out.txt",
    },
    reason: "Manual permission mode requires approval",
  }, actor);
  writer.append("authority.granted", {
    runId,
    stepId,
    actionId,
    leaseId: "lea_write",
    policyTrace: [{ leaseId: "lea_write", matched: true, reason: "write lease" }],
  }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId,
    modelOutput: [{ type: "text", text: JSON.stringify({ path: "out.txt" }) }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  assert.equal(view.runs[runId]?.environment?.permissionMode, "manual");
  assert.equal(view.runs[runId]?.environment?.sandbox?.backend, "srt-windows");
  assert.equal(view.runs[runId]?.actions[actionId]?.approval?.scope, "session");
  assert.equal(view.runs[runId]?.actions[actionId]?.approval?.source, "interactive");

  const narrative = projectWebSession(view, store.read(sessionId).events);
  const run = narrative.runs[0];
  assert.equal(run.environment?.permissionMode, "manual");
  assert.equal(run.environment?.sandbox?.backend, "srt-windows");
  assert.equal(run.environment?.sandbox?.strength, "full");
  assert.equal(run.summary.approvalDecisions, 1);
  const action = run.steps[0].actions[0];
  assert.equal(action.approval?.decision, "allow");
  assert.equal(action.approval?.scope, "session");
  assert.equal(action.approval?.source, "interactive");
  assert.equal(action.approval?.pattern.tool, "write");
});

test("Web narrative shows full git request on INVALID_GIT_ARGUMENT failures", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_web_git_arg";
  const runId = "run_web_git_arg";
  const stepId = "stp_web_git_arg";
  const actionId = "act_web_git_arg";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Git argument failure" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "inspect git" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId,
    toolName: "git",
    effect: "read",
    input: { operation: "status", ref: "HEAD" },
    resources: ["vcs:."],
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", { runId, stepId, actionId, leaseId: "lea_git" }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  writer.append("action.failed", {
    runId,
    stepId,
    actionId,
    errorCode: "INVALID_GIT_ARGUMENT",
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        code: "INVALID_GIT_ARGUMENT",
        message: "ref is only valid for rev-parse and show",
        details: { command: "git status · ref HEAD", operation: "status", ref: "HEAD" },
      }),
    }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  const narrative = projectWebSession(view, store.read(sessionId).events);
  const action = narrative.runs[0].steps[0].actions[0];
  assert.equal(action.toolName, "git");
  assert.equal(action.target, "git status · ref HEAD");
  assert.equal(action.errorCode, "INVALID_GIT_ARGUMENT");
  assert.equal(
    action.resultSummary,
    "git status · ref HEAD · ref is only valid for rev-parse and show",
  );
  assert.equal(action.result?.details?.command, "git status · ref HEAD");
});

test("Web read_image targets prefer image #N · source over raw artifact refs", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_web_read_image";
  const runId = "run_web_read_image";
  const stepId = "stp_web_read_image";
  const actionId = "act_web_read_image";
  const actor = { kind: "runtime", id: "test" };
  const originalArtifactRef = `artifact://${"e".repeat(64)}`;
  const preparedArtifactRef = `artifact://${"f".repeat(64)}`;
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Read image" }, actor);
  writer.append("run.triggered", {
    runId,
    trigger: "user",
    input: "[image #1 (1689×1221)] crop the title",
    content: [
      { type: "text", text: "[image #1 (1689×1221)] crop the title" },
      {
        type: "image",
        source: "path",
        originalArtifactRef,
        preparedArtifactRef,
        originalMediaType: "image/png",
        mediaType: "image/png",
        originalByteLength: 2400,
        byteLength: 1800,
        originalWidth: 1689,
        originalHeight: 1221,
        width: 1689,
        height: 1221,
        downsampled: false,
        formatChanged: false,
        orientationApplied: false,
      },
    ],
  }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId,
    toolName: "read_image",
    effect: "read",
    input: {
      artifactRef: originalArtifactRef,
      region: { x: 40, y: 900, width: 480, height: 80 },
    },
    resources: [originalArtifactRef],
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", { runId, stepId, actionId, leaseId: "lea_read_image" }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId,
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        artifactRef: `artifact://${"a".repeat(64)}`,
        mediaType: "image/png",
        byteLength: 1200,
        width: 480,
        height: 80,
        originalWidth: 1689,
        originalHeight: 1221,
        resized: false,
        region: { x: 40, y: 900, width: 480, height: 80 },
      }),
    }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  const narrative = projectWebSession(view, store.read(sessionId).events);
  const run = narrative.runs[0];
  assert.deepEqual(run.imageAttachments, [{
    index: 1,
    source: "path",
    mediaType: "image/png",
    width: 1689,
    height: 1221,
    originalArtifactRef,
  }]);
  const action = run.steps[0].actions[0];
  assert.equal(action.toolName, "read_image");
  assert.equal(action.target, "image #1 · path · crop 40,900 480×80 · 480×80");
  assert.equal(action.resultSummary, "crop 40,900 480×80 · 480×80 · image/png");
  assert.doesNotMatch(action.target, /"artifactRef"/);
  assert.doesNotMatch(action.target, /e{16}/);
});

test("Web observes automatic Skill Tool calls without exposing Skill instructions", () => {
  const store = new InMemoryEventStore();
  const sessionId = "ses_web_skill_call";
  const runId = "run_web_skill_call";
  const stepId = "stp_web_skill_call";
  const actionId = "act_web_skill_call";
  const actor = { kind: "runtime", id: "test" };
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", { title: "Skill call" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "Use the relevant Skill" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("step.started", { runId, stepId }, actor);
  writer.append("action.proposed", {
    runId,
    stepId,
    actionId,
    toolName: "skill",
    input: { operation: "load", name: "review-code" },
    resources: ["skill:review-code"],
    effect: "read",
  }, actor);
  writer.append("step.completed", { runId, stepId, finishReason: "action-requested" }, actor);
  writer.append("authority.requested", { runId, stepId, actionId }, actor);
  writer.append("authority.granted", { runId, stepId, actionId, leaseId: "lea_web_skill" }, actor);
  writer.append("action.started", { runId, stepId, actionId }, actor);
  writer.append("action.completed", {
    runId,
    stepId,
    actionId,
    modelOutput: [{
      type: "text",
      text: JSON.stringify({
        name: "review-code",
        scope: "user",
        version: "1.0.0",
        instructions: "do not expose this body",
      }),
    }],
  }, actor);
  writer.append("run.completed", { runId, completionKind: "response", evaluationIds: [] }, actor);

  const view = store.load(sessionId);
  assert.ok(view);
  const narrative = projectWebSession(view, store.read(sessionId).events);
  const run = narrative.runs[0];
  assert.deepEqual(run.skills, []);
  assert.deepEqual(run.skillCalls, [{
    name: "review-code",
    scope: "user",
    operation: "load",
    status: "completed",
    errorCode: undefined,
  }]);
  assert.equal(run.summary.skillStatus, "succeeded");
  const action = run.steps[0].actions[0];
  assert.equal(action.result, undefined);
  assert.doesNotMatch(JSON.stringify(narrative), /do not expose this body/);
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
    effect: "read",
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
    assert.match(page, /Background Jobs/);
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

test("Web workbench renders Subagent Tasks for the selected Run", async () => {
  const store = new InMemoryEventStore();
  const hub = new SessionEventHub();
  const sessionId = "ses_web_delegations";
  const childSessionId = "ses_web_child_001";
  const runId = "run_web_delegations";
  const delegationId = "dlg_web_sub_001";
  const writer = new EventWriter(store, sessionId);
  const actor = { kind: "runtime", id: "test" };
  writer.append("session.created", { title: "Parent research" }, actor);
  writer.append("run.triggered", { runId, trigger: "user", input: "Explore auth" }, actor);
  writer.append("run.started", { runId }, actor);
  writer.append("delegation.created", {
    runId,
    delegationId,
    childSessionId,
    outcome: "Map login and session expiry paths",
    returnPolicy: "result",
    depth: 1,
    receiptId: "rcp_web_delegate",
    parentLeaseId: "lea_tui_delegate_scope",
    childLeaseId: "lea_web_child",
    childSubject: "agent_child",
    contextRefs: ["artifact://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    contractRef: "artifact://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    resourceEnvelope: { maxSteps: 8, contextTokens: 40_000 },
  }, actor);
  writer.append("delegation.returned", {
    runId,
    delegationId,
    childSessionId,
    outcome: "timed_out",
    evidenceRefs: [],
    coordinationWallTimeMs: 300_000,
    reasons: ["child wall clock expired"],
  }, actor);
  writer.append("step.started", { runId, stepId: "stp_web_delegations" }, actor);
  writer.append("model.completed", {
    runId,
    stepId: "stp_web_delegations",
    requestId: "req_web_delegations",
    provider: "test",
    model: "deterministic",
    finishReason: "stop",
    text: "Partial research after Subagent timeout.",
    actionCalls: [],
  }, actor);
  writer.append("step.completed", {
    runId,
    stepId: "stp_web_delegations",
    finishReason: "response",
  }, actor);
  writer.append("run.completed", {
    runId,
    completionKind: "response",
    evaluationIds: [],
  }, actor);

  const server = new QiWebServer({ eventStore: store, eventHub: hub });
  const address = await server.listen();
  try {
    const page = await fetch(address.url).then((response) => response.text());
    assert.match(page, /Subagent Tasks/);
    const application = await fetch(`${address.url}/app.js`).then((response) => response.text());
    assert.match(application, /function renderSubagents/);
    assert.match(application, /data-child-session/);
    for (const eventType of ["delegation.created", "delegation.returned"]) {
      assert.match(application, new RegExp(eventType.replace(".", "\\.")));
    }

    const workbench = await fetch(`${address.url}/api/session/${sessionId}/workbench`).then((response) => response.json());
    const delegation = workbench.view.runs[runId].delegations[delegationId];
    assert.equal(delegation.status, "timed_out");
    assert.equal(delegation.childSessionId, childSessionId);
    assert.equal(delegation.outcome, "Map login and session expiry paths");
    assert.deepEqual(delegation.reasons, ["child wall clock expired"]);
  } finally {
    await server.close();
  }
});
