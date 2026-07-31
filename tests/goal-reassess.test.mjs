import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TuiRuntime } from "../apps/cli/dist/index.js";

test("reassessGoalEvidence fail records evaluation and does not complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-goal-reassess-"));
  let runtime;
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      qiHome: join(root, "home"),
      projectId: "goal-reassess",
      modelPort: new ScriptedModelPort([]),
      model: { provider: "fake", model: "goal-reassess-v1" },
    });
    const goal = runtime.createGoal({
      objective: "Make tests pass",
      assertions: [{ assertionId: "objective.met", description: "Make tests pass", required: true }],
      evidenceRequirements: [
        { assertionId: "objective.met", kinds: ["human"], minimum: 1 },
      ],
    });
    const result = await runtime.reassessGoalEvidence({
      outcome: "fail",
      rationale: "Unit tests still red",
    });
    assert.equal(result.completed, false);
    assert.equal(result.outcome, "fail");
    assert.notEqual(result.goal.state, "complete");
    const view = runtime.view();
    const evaluations = Object.values(view.goals[goal.goalId].evaluations);
    assert.ok(evaluations.some((evaluation) => evaluation.outcome === "fail"));
    assert.ok(Object.values(view.evidence).some((item) => item.kind === "human"));
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
