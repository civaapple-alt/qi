import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { McpBridge } from "@civaapple/qi-node/mcp";
import { AuthorityDeniedError, FileArtifactStore, ToolInputError, ToolRegistry } from "@civaapple/qi-node/tools";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-mcp-test-"));
  const artifacts = join(root, "artifacts");
  await mkdir(artifacts);
  try { await run({ root, artifactStore: new FileArtifactStore(artifacts) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function context(root, artifactStore, actionId = "act_mcp_001") {
  return { sessionId: "ses_mcp_001", runId: "run_mcp_001", stepId: "stp_mcp_001", actionId, subject: "agent_main", workspaceRoot: root, artifactStore };
}

test("MCP discovery quarantines remote tools; only explicit binding enters the catalog", async () => {
  let calls = 0;
  const transport = {
    async listTools() { return [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }]; },
    async callTool() { calls += 1; return { ok: true }; },
  };
  const broker = new InMemoryCapabilityBroker();
  const registry = new ToolRegistry(broker);
  const bridge = new McpBridge("knowledge", transport);
  const candidates = await bridge.discover();
  assert.equal(candidates[0].state, "quarantined");
  assert.deepEqual(registry.catalog(), []);
  const handle = bridge.bind(registry, { remoteName: "lookup", localName: "knowledge_lookup", effect: "read", resources: (input) => [`mcp:knowledge:lookup:${input.query}`] });
  await fixture(async ({ root, artifactStore }) => {
    await assert.rejects(registry.execute("knowledge_lookup", handle.identity, { query: "x" }, context(root, artifactStore)), AuthorityDeniedError);
    assert.equal(calls, 0);
    await assert.rejects(registry.execute("knowledge_lookup", handle.identity, { query: 1 }, context(root, artifactStore)), ToolInputError);
    assert.equal(calls, 0);
  });
});

test("Bound MCP calls are independently authorized and oversized output becomes an Artifact", async () => {
  const payload = { text: "x".repeat(2_000) };
  let calls = 0;
  const transport = {
    async listTools() { return [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }]; },
    async callTool() { calls += 1; return payload; },
  };
  const broker = new InMemoryCapabilityBroker();
  broker.grant({ leaseId: "lea_mcp_test", subject: "agent_main", tools: ["knowledge_lookup"], effects: ["read"], resources: ["mcp:knowledge:**"], expiresAt: "2099-01-01T00:00:00.000Z" });
  const registry = new ToolRegistry(broker);
  const bridge = new McpBridge("knowledge", transport);
  await bridge.discover();
  const handle = bridge.bind(registry, { remoteName: "lookup", localName: "knowledge_lookup", effect: "read", resources: () => ["mcp:knowledge:lookup"], maximumModelBytes: 256 });
  await fixture(async ({ root, artifactStore }) => {
    const result = await registry.execute("knowledge_lookup", handle.identity, { query: "qi" }, context(root, artifactStore));
    assert.equal(calls, 1);
    assert.equal(result.output.truncated, true);
    assert.ok(result.output.preview.length <= 256);
    assert.match(result.output.artifactRef, /^artifact:\/\//);
    const stored = await artifactStore.get(result.output.artifactRef);
    assert.deepEqual(JSON.parse(Buffer.from(stored.content).toString()), payload);
  });
});
