import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { TuiPresenter } from "../apps/cli/dist/index.js";

test("500-Run timeline cold render and provisional soak stay bounded", () => {
  const heapBefore = process.memoryUsage().heapUsed;
  const actor = { kind: "runtime", id: "stress" };
  const events = [];
  const runs = {};
  const runOrder = [];
  let sequence = 1;

  for (let runNumber = 1; runNumber <= 500; runNumber += 1) {
    const runId = `run_stress_${runNumber}`;
    const steps = {};
    const stepOrder = [];
    const actions = {};
    runOrder.push(runId);
    for (let stepNumber = 1; stepNumber <= 4; stepNumber += 1) {
      const stepId = `stp_stress_${runNumber}_${stepNumber}`;
      stepOrder.push(stepId);
      steps[stepId] = {
        stepId,
        status: "completed",
        context: {
          estimatedTokens: 1_000,
          budgetTokens: 64_000,
          includedBlockIds: [],
          omittedBlockIds: [],
        },
        model: {
          text: `Run ${runNumber} step ${stepNumber} complete.`,
          finishReason: "stop",
        },
      };
      for (const [offset, toolName] of ["read", "find", "search"].entries()) {
        const actionId = `act_stress_${runNumber}_${stepNumber}_${offset + 1}`;
        actions[actionId] = {
          actionId,
          stepId,
          toolName,
          effect: "read",
          status: "completed",
          resources: [],
        };
        events.push(
          stressEvent(sequence++, "action.proposed", actor, {
            runId,
            stepId,
            actionId,
            toolName,
            effect: "read",
            input: { query: `run ${runNumber}` },
            resources: [],
          }),
          stressEvent(sequence++, "action.started", actor, { runId, stepId, actionId }),
          stressEvent(sequence++, "action.completed", actor, {
            runId,
            stepId,
            actionId,
            modelOutput: [],
          }),
        );
      }
      events.push(stressEvent(sequence++, "model.completed", actor, {
        runId,
        stepId,
        text: `Run ${runNumber} step ${stepNumber} complete.`,
        finishReason: "stop",
        usage: { inputTokens: 800, outputTokens: 200 },
      }));
    }
    runs[runId] = {
      runId,
      trigger: "user",
      mode: "agent",
      status: "completed",
      input: `stress prompt ${runNumber}`,
      stepOrder,
      steps,
      actions,
      evaluations: {},
      steering: [],
      delegations: {},
      terminal: { type: "completed", reason: "response" },
    };
  }

  assert.equal(events.length, 20_000);
  assert.equal(Object.values(runs).reduce((sum, run) => sum + Object.keys(run.actions).length, 0), 6_000);
  const view = {
    sessionId: "ses_stress",
    createdAt: new Date(0).toISOString(),
    version: events.length,
    mode: "agent",
    runOrder,
    runs,
    goals: {},
    goalOrder: [],
    evidence: {},
    controlReceipts: {},
    memories: {},
    memoryOrder: [],
    tasks: {},
    taskOrder: [],
    plans: {},
    planOrder: [],
    presence: { state: "idle" },
  };
  const presenter = new TuiPresenter({
    workspaceRoot: "/tmp/stress",
    dataRoot: "/tmp/stress/.qi",
    provider: "fake",
    model: "stress",
    capabilities: [],
    contextWindowTokens: 80_000,
    contextBudgetTokens: 64_000,
    outputReserveTokens: 16_000,
    historyBudgetTokens: 16_000,
    maxSteps: 20,
    maxActionsPerStep: 6,
  });

  const coldStart = performance.now();
  presenter.update(events, view);
  const rendered = presenter.render(80);
  const coldMs = performance.now() - coldStart;
  assert.ok(coldMs <= 2_000, `cold projection and first render took ${coldMs.toFixed(1)}ms`);
  assert.ok(rendered.length <= 1_200);
  assert.match(rendered.join("\n"), /… 488 earlier Runs · \/runs/);
  assert.match(rendered.join("\n"), /stress prompt 500/);
  assert.doesNotMatch(rendered.join("\n"), /stress prompt 1(?:\D|$)/);
  assert.equal(presenter.historyRunItems().length, 500);

  const chromeStart = performance.now();
  for (let tick = 0; tick < 100_000; tick += 1) {
    presenter.applyActivity({
      type: "model.reasoning",
      sessionId: "ses_stress",
      runId: "run_stress_500",
      stepId: "stp_stress_500_4",
      text: `bounded provisional ${tick}`,
      estimatedOutputTokens: tick,
      provisional: true,
    });
  }
  const soakMs = performance.now() - chromeStart;
  assert.ok(soakMs <= 2_000, `100k provisional updates took ${soakMs.toFixed(1)}ms`);

  const committedPaintMs = [];
  for (let update = 1; update <= 100; update += 1) {
    const started = performance.now();
    assert.equal(presenter.applyCommitted(
      stressEvent(sequence++, "presence.changed", actor, { state: "idle" }),
      view,
    ), true);
    presenter.render(80);
    committedPaintMs.push(performance.now() - started);
  }
  assert.ok(percentile(committedPaintMs, 0.95) <= 50, "steady committed event-to-paint p95 exceeded 50ms");

  const chromePaintMs = [];
  for (let tick = 0; tick < 1_000; tick += 1) {
    const started = performance.now();
    presenter.renderWorking(true, tick, 80);
    chromePaintMs.push(performance.now() - started);
  }
  assert.ok(percentile(chromePaintMs, 0.95) <= 8, "chrome p95 exceeded 8ms");

  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  assert.ok(heapDelta <= 150 * 1024 * 1024, `heap grew ${(heapDelta / 1024 / 1024).toFixed(1)}MB`);
});

function stressEvent(sequence, type, actor, data) {
  return {
    schemaVersion: 1,
    eventId: `evt_stress_${sequence}`,
    sessionId: "ses_stress",
    sequence,
    occurredAt: new Date(sequence).toISOString(),
    actor,
    type,
    data,
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}
