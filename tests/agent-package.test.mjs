import assert from "node:assert/strict";
import test from "node:test";
import { QiAgent } from "@civaapple/qi-agent";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { defineTool } from "@civaapple/qi-node/tools";
import { Type } from "@sinclair/typebox";

const model = { provider: "scripted", model: "agent-package-test" };

function echoTool(onExecute) {
  return defineTool({
    description: "Echo text for an Agent package consumer test",
    input: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    output: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    effect: () => "read",
    resources: () => ["echo:local"],
    async execute(input) {
      onExecute();
      return { text: input.text };
    },
  });
}

test("@civaapple/qi-agent completes a response and exposes committed Session truth", async () => {
  const port = new ScriptedModelPort([[
    { type: "text.delta", delta: "Hello from the embedded Agent." },
    { type: "completed", finishReason: "stop" },
  ]]);
  const observed = [];
  const agent = new QiAgent({ modelPort: port, model });
  const unsubscribe = agent.subscribe((event) => observed.push(event.type));

  const result = await agent.prompt("Say hello.");
  unsubscribe();

  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hello from the embedded Agent.");
  assert.equal(agent.view?.sessionId, agent.sessionId);
  assert.deepEqual(agent.events().map((event) => event.type), observed);
  assert.equal(agent.events().at(-1)?.type, "run.completed");
});

test("@civaapple/qi-agent is default-deny even after a Tool is registered", async () => {
  let executions = 0;
  const port = new ScriptedModelPort([
    [
      {
        type: "action.requested",
        callId: "call-echo-denied",
        name: "echo",
        input: { text: "should not execute" },
      },
      { type: "completed", finishReason: "actions" },
    ],
    [
      { type: "text.delta", delta: "The Tool was denied." },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const agent = new QiAgent({ modelPort: port, model });
  agent.registerTool("echo", echoTool(() => {
    executions += 1;
  }));

  const result = await agent.prompt("Call echo without authority.");

  assert.equal(result.status, "completed");
  assert.equal(executions, 0);
  assert.ok(agent.events().some((event) => event.type === "authority.denied"));
  assert.equal(agent.events().some((event) => event.type === "action.started"), false);
});

test("@civaapple/qi-agent preserves authority-before-executor for an explicit grant", async () => {
  let executions = 0;
  const port = new ScriptedModelPort([
    [
      {
        type: "action.requested",
        callId: "call-echo-granted",
        name: "echo",
        input: { text: "authorized" },
      },
      { type: "completed", finishReason: "actions" },
    ],
    [
      { type: "text.delta", delta: "The authorized Tool completed." },
      { type: "completed", finishReason: "stop" },
    ],
  ]);
  const agent = new QiAgent({ modelPort: port, model });
  agent.registerTool("echo", echoTool(() => {
    executions += 1;
    const last = agent.events().at(-1);
    assert.equal(last?.type, "action.started");
  }));
  agent.grant({
    leaseId: "lea_agent_echo",
    subject: "main-agent",
    tools: ["echo"],
    effects: ["read"],
    resources: ["echo:local"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });

  const result = await agent.prompt("Call echo with authority.");

  assert.equal(result.status, "completed");
  assert.equal(executions, 1);
  const types = agent.events().map((event) => event.type);
  assert.ok(types.indexOf("authority.granted") < types.indexOf("action.started"));
  assert.ok(types.indexOf("action.started") < types.indexOf("action.completed"));
});
