import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TuiRuntime } from "../apps/cli/dist/index.js";

test("continueGoal guidance becomes the Goal-bound Run input", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-goal-guidance-"));
  let runtime;
  const guidance = "Stop editing docs; only fix the failing unit test.";
  const model = new ScriptedModelPort([
    (request) => {
      const prompt = request.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(prompt, /Stop editing docs/);
      assert.match(prompt, /failing unit test/);
      return [
        { type: "text.delta", delta: "Focusing on the unit test." },
        { type: "completed", finishReason: "stop" },
      ];
    },
  ]);
  try {
    runtime = await TuiRuntime.create({
      workspaceRoot: root,
      dataRoot: join(root, ".qi"),
      qiHome: join(root, "home"),
      projectId: "goal-guidance",
      modelPort: model,
      model: { provider: "fake", model: "goal-guidance-v1" },
    });
    const goal = runtime.createGoal({
      objective: "Make tests pass",
      assertions: [{ assertionId: "objective.met", description: "Make tests pass", required: true }],
      evidenceRequirements: [
        { assertionId: "objective.met", kinds: ["human"], minimum: 1 },
      ],
      resources: [{ resource: "attempts", limit: 8, unit: "attempt" }],
    });
    assert.equal(goal.state, "active");
    const result = await runtime.continueGoal(guidance);
    assert.equal(result.status, "completed");
    const run = runtime.view()?.runs[result.runId];
    assert.equal(run?.trigger, "goal");
    assert.equal(run?.goalBinding?.goalId, goal.goalId);
    assert.equal(run?.input, guidance);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
