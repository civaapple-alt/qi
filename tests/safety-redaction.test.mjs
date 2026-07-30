import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker, redactSensitiveText, redactSensitiveValue } from "@civaapple/qi-agent/capability";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { EventWriter, TurnLoop } from "@civaapple/qi-agent/loop";
import {
  FileArtifactStore,
  ToolRegistry,
  isSensitiveWorkspacePath,
  listTool,
  readTool,
} from "@civaapple/qi-node/tools";

const bearer = "bearer-value-12345678";
const providerToken = "sk-abcdefghijklmnopqrstuvwxyz012345";

test("redaction keeps source assignments and still strips high-confidence literals", () => {
  const text = [
    `"password": "fixture-password-9274"`,
    "password: &str",
    "jwt_secret: env::var(\"JWT_SECRET\")",
    "apiKey: process.env.OPENAI_API_KEY",
    `Authorization: Bearer ${bearer}`,
    `token ${providerToken}`,
  ].join("\n");
  const result = redactSensitiveText(text);
  assert.match(result.value, /fixture-password-9274/);
  assert.match(result.value, /password: &str/);
  assert.match(result.value, /jwt_secret: env::var/);
  assert.match(result.value, /process\.env\.OPENAI_API_KEY/);
  assert.doesNotMatch(result.value, new RegExp(bearer));
  assert.doesNotMatch(result.value, new RegExp(providerToken));
  assert.match(result.value, /REDACTED:authorization/);
  assert.match(result.value, /REDACTED:provider-token/);
  assert.equal(
    redactSensitiveText(result.value).value,
    result.value,
    "literal redaction must be idempotent",
  );
});

test("EventWriter redacts durable event data and appends a value-free safety audit", () => {
  const store = new InMemoryEventStore();
  const writer = new EventWriter(store, "ses_redaction_writer");
  writer.append("session.created", { title: "redaction test" }, { kind: "runtime", id: "test" });
  writer.append(
    "run.triggered",
    { runId: "run_redaction_writer", trigger: "user", input: `Authorization: Bearer ${bearer}` },
    { kind: "user", id: "user" },
  );
  const events = store.read("ses_redaction_writer").events;
  assert.deepEqual(events.map((event) => event.type), [
    "session.created",
    "safety.redaction.applied",
    "run.triggered",
  ]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(bearer));
  assert.equal(events[1].data.boundary, "event-store");
});

test("sensitive path classifier recognizes env and example exclusions", () => {
  assert.equal(isSensitiveWorkspacePath(".env"), true);
  assert.equal(isSensitiveWorkspacePath(".env.local"), true);
  assert.equal(isSensitiveWorkspacePath(".env.example"), false);
  assert.equal(isSensitiveWorkspacePath("certs/server.pem"), true);
  assert.equal(isSensitiveWorkspacePath("src/lib.rs"), false);
  assert.equal(isSensitiveWorkspacePath("local.properties", { extra: ["local.properties"] }), true);
  assert.equal(isSensitiveWorkspacePath(".env", { exclude: [".env"] }), false);
});

test("TurnLoop denies unggranted .env content before the model sees the secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-sensitive-deny-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  const secret = "fixture-env-secret-9274";
  await writeFile(join(root, ".env"), `API_TOKEN=${secret}\n`);
  await writeFile(join(root, "readme.md"), "ok\n");
  try {
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_sensitive_read",
      subject: "agent_main",
      tools: ["read", "list"],
      effects: ["read"],
      resources: ["file:**", "tree:**"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("list", listTool);
    const model = new ScriptedModelPort([
      [
        { type: "action.requested", callId: "call_list", name: "list", input: { path: "." } },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        const payload = JSON.stringify(request.messages);
        assert.match(payload, /\.env/);
        assert.doesNotMatch(payload, new RegExp(secret));
        return [
          { type: "action.requested", callId: "call_read", name: "read", input: { path: ".env" } },
          { type: "completed", finishReason: "actions" },
        ];
      },
      (request) => {
        const payload = JSON.stringify(request.messages);
        assert.match(payload, /SENSITIVE_PATH_GRANT_REQUIRED/);
        assert.doesNotMatch(payload, new RegExp(secret));
        return [
          { type: "text.delta", delta: "Need a human grant for .env." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const store = new InMemoryEventStore();
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    await loop.run({
      sessionId: "ses_sensitive_deny",
      subject: "agent_main",
      input: "Inspect env",
      model: { provider: "fake", model: "sensitive-v1" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 4,
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifacts),
    });
    const events = store.read("ses_sensitive_deny").events;
    assert.ok(events.some((event) => event.type === "action.failed" && event.data.errorCode === "SENSITIVE_PATH_GRANT_REQUIRED"));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TurnLoop returns granted sensitive file content so precise edit can round-trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-sensitive-allow-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  const secret = "fixture-env-secret-4411";
  await writeFile(join(root, ".env"), `API_TOKEN=${secret}\n`);
  try {
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_sensitive_granted",
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
        { type: "action.requested", callId: "call_read", name: "read", input: { path: ".env" } },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        assert.match(JSON.stringify(request.messages), new RegExp(secret));
        assert.doesNotMatch(JSON.stringify(request.messages), /SENSITIVE_PATH_GRANT_REQUIRED/);
        return [
          { type: "text.delta", delta: "Received env content." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const store = new InMemoryEventStore();
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    await loop.run({
      sessionId: "ses_sensitive_allow",
      subject: "agent_main",
      input: "Read env",
      model: { provider: "fake", model: "sensitive-v1" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 3,
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifacts),
      getSensitivePathGrants: () => [".env"],
    });
    const events = store.read("ses_sensitive_allow").events;
    assert.ok(events.some((event) => event.type === "action.completed"));
    assert.match(JSON.stringify(events), new RegExp(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary source with password type annotations round-trips without assignment redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-source-roundtrip-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  const source = "pub fn hash_password(password: &str) -> String { password.into() }\n";
  await writeFile(join(root, "auth.rs"), source);
  try {
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_source_read",
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
        { type: "action.requested", callId: "call_read", name: "read", input: { path: "auth.rs" } },
        { type: "completed", finishReason: "actions" },
      ],
      (request) => {
        assert.match(JSON.stringify(request.messages), /password: &str/);
        assert.doesNotMatch(JSON.stringify(request.messages), /REDACTED:credential-assignment/);
        return [
          { type: "text.delta", delta: "Source looks clean." },
          { type: "completed", finishReason: "stop" },
        ];
      },
    ]);
    const store = new InMemoryEventStore();
    const loop = new TurnLoop({ eventStore: store, modelPort: model, toolRegistry: registry });
    await loop.run({
      sessionId: "ses_source_roundtrip",
      subject: "agent_main",
      input: "Read auth",
      model: { provider: "fake", model: "source-v1" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 3,
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifacts),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
