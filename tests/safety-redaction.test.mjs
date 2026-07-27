import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker, redactSensitiveText, redactSensitiveValue } from "@civaapple/qi-capability";
import { InMemoryEventStore } from "@civaapple/qi-kernel";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import { EventWriter, TurnLoop } from "@civaapple/qi-loop";
import { FileArtifactStore, ToolRegistry, readTool } from "@civaapple/qi-tools";

const secret = "fixture-password-9274";

test("redaction removes credential assignments and tokens without corrupting code references", () => {
  const text = [
    `"password": "${secret}"`,
    `api_key=${secret}`,
    "apiKey: process.env.OPENAI_API_KEY",
    "const schema = { apiKey: Type.String() };",
    "Authorization: Bearer bearer-value-123456",
  ].join("\n");
  const result = redactSensitiveText(text);
  assert.doesNotMatch(result.value, new RegExp(secret));
  assert.match(result.value, /process\.env\.OPENAI_API_KEY/);
  assert.match(result.value, /apiKey: Type\.String\(\)/);
  assert.ok(result.redactions.reduce((total, entry) => total + entry.count, 0) >= 3);

  const nested = redactSensitiveValue({ output: [{ content: text }] });
  assert.doesNotMatch(JSON.stringify(nested.value), new RegExp(secret));
});

test("EventWriter redacts durable event data and appends a value-free safety audit", () => {
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, "ses_redaction_writer");
  writer.append("session.created", { title: "redaction test" }, { kind: "runtime", id: "test" });
  writer.append(
    "run.triggered",
    { runId: "run_redaction_writer", trigger: "user", input: `password=${secret}` },
    { kind: "user", id: "user" },
  );
  const events = store.read("ses_redaction_writer").events;
  assert.deepEqual(events.map((event) => event.type), [
    "session.created",
    "safety.redaction.applied",
    "run.triggered",
  ]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  assert.equal(events[1].data.boundary, "event-store");
});

test("TurnLoop never sends a secret read from the Workspace into the next model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-redaction-loop-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(root, "inspector.config.json"), `{"password":"${secret}"}`);
  try {
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_redaction_read",
      subject: "agent_main",
      tools: ["read"],
      effects: ["read"],
      resources: ["file:**"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call_read", name: "read", input: { path: "inspector.config.json" } },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        assert.doesNotMatch(JSON.stringify(request.messages), new RegExp(secret));
        assert.match(JSON.stringify(request.messages), /REDACTED/);
        return [
          { type: "text.delta", delta: "Sensitive configuration was withheld." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const store = new InMemoryEventStore();
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    await loop.run({
      sessionId: "ses_redaction_loop",
      subject: "agent_main",
      input: "Inspect the configuration",
      model: { provider: "fake", model: "redaction-v1" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 3,
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifacts),
    });
    const events = store.read("ses_redaction_loop").events;
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
    assert.ok(events.some((event) => event.type === "safety.redaction.applied" && event.data.boundary === "tool-output"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
