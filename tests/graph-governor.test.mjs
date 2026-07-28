import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { GraphGovernor } from "@civaapple/qi-agent/extensions";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";

function definition(version = 1) {
  return {
    id: "delivery", version, start: "understand",
    nodes: [
      { id: "understand", observe: ["workspace"], actions: ["read", "search"], skills: ["analysis"] },
      { id: "implement", observe: ["workspace", "tests"], actions: ["read", "write", "test"], skills: ["coding"] },
      { id: "clarify", observe: ["user"], actions: ["ask"], skills: [] },
    ],
    edges: [
      { id: "ready", from: "understand", to: "implement", when: { kind: "fact", path: ["requirements", "ready"], operator: "equals", value: true } },
      { id: "unclear", from: "understand", to: "clarify", when: { kind: "model", choice: "ask-user", description: "Requirements are materially ambiguous" } },
    ],
  };
}

function active() {
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, "ses_graph_001");
  writer.append("session.created", {}, { kind: "user", id: "user" });
  writer.append("run.triggered", { runId: "run_graph_001", trigger: "user" }, { kind: "user", id: "user" });
  writer.append("run.started", { runId: "run_graph_001" }, { kind: "runtime", id: "qi" });
  writer.append("step.started", { runId: "run_graph_001", stepId: "stp_graph_001" }, { kind: "runtime", id: "qi" });
  return { store, writer };
}

test("Graph Governor narrows tools and deterministic guards outrank model routing", () => {
  const { store, writer } = active();
  const graph = new GraphGovernor(definition(), { writer, runId: "run_graph_001" });
  const catalog = ["read", "search", "write", "shell"].map((name) => ({ name, identity: `${name}@1`, model: { name, description: name, inputSchema: {} } }));
  assert.deepEqual(graph.filterTools(catalog).map((tool) => tool.name), ["read", "search"]);
  assert.deepEqual(graph.modelChoices({ requirements: { ready: true } }), []);
  const route = graph.advance({ requirements: { ready: true } }, "ask-user");
  assert.equal(route.decision, "deterministic");
  assert.equal(graph.currentNode.id, "implement");
  const projected = store.load("ses_graph_001").runs.run_graph_001.graph;
  assert.equal(projected.currentNode, "implement");
  assert.deepEqual(projected.path.map((entry) => entry.nodeId), ["understand", "implement"]);
});

test("Model routing is constrained to explicitly offered current-node choices", () => {
  const graph = new GraphGovernor(definition());
  assert.deepEqual(graph.modelChoices({ requirements: { ready: false } }).map((choice) => choice.choice), ["ask-user"]);
  assert.throws(() => graph.advance({ requirements: { ready: false } }, "invent-route"), /not uniquely allowed/);
  assert.equal(graph.advance({ requirements: { ready: false } }, "ask-user").to, "clarify");
});

test("Dynamic Graph replacement is schema-validated and independently authorized", async () => {
  const { store, writer } = active();
  const graph = new GraphGovernor(definition(), { writer, runId: "run_graph_001" });
  const denied = await graph.replaceAuthorized({ replacement: definition(2), definitionRef: "artifact://graph-v2", broker: new InMemoryCapabilityBroker(), subject: "agent_main", writer, runId: "run_graph_001", stepId: "stp_graph_001" });
  assert.equal(denied, false);
  assert.equal(graph.definition.version, 1);
  const broker = new InMemoryCapabilityBroker();
  broker.grant({ leaseId: "lea_graph_001", subject: "agent_main", tools: ["graph.modify"], effects: ["write"], resources: ["graph:delivery"], expiresAt: "2099-01-01T00:00:00.000Z" });
  assert.equal(await graph.replaceAuthorized({ replacement: definition(2), definitionRef: "artifact://graph-v2", broker, subject: "agent_main", writer, runId: "run_graph_001", stepId: "stp_graph_001" }), true);
  assert.equal(store.load("ses_graph_001").runs.run_graph_001.graph.graphVersion, 2);
  const events = store.read("ses_graph_001").events;
  assert.equal(events.filter((event) => event.type === "graph.definition.updated").length, 1);
  assert.equal(events.filter((event) => event.type === "action.started").length, 1);
  assert.equal(events.filter((event) => event.type === "authority.denied").length, 1);
});
