import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SkillCatalog,
  SkillLoader,
  evaluateSkillReadiness,
  runSkillScript,
} from "../packages/node/dist/skills/index.js";
import {
  McpDeclarationCatalog,
  McpConnectionManager,
  McpReviewStore,
  SealedMcpOAuthProvider,
  candidateFromRaw,
  fingerprintMcpValue,
  mcpTargetResource,
  parseDeclaration,
} from "../packages/node/dist/mcp/index.js";

const execFileAsync = promisify(execFile);

test("Skill full-tree install preserves binary resources, advisory metadata, locks, and bounded scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-skill-production-"));
  try {
    const workspace = join(root, "workspace");
    const source = join(root, "safe-demo");
    await mkdir(join(source, "scripts"), { recursive: true });
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), `---\nname: safe-demo\ndescription: Exercises the production Skill contract.\nlicense: MIT\ncompatibility: Node 22\nmetadata:\n  qi.required-executables: missing-qi-test-command\n  qi.required-mcp: browser\nallowed-tools: Bash(missing-qi-test-command:*) mcp__browser__open\nhidden: true\n---\nFollow the reviewed workflow.\n`);
    await writeFile(join(source, "scripts", "help.mjs"), "if (process.argv[2] !== '--help') process.exit(9); console.log('safe-demo help');\n");
    await writeFile(join(source, "assets", "pixel.bin"), Buffer.from([0, 255, 1, 254]));

    const loaded = await new SkillLoader().load(source, { enforceDirectoryName: true });
    assert.equal(loaded.extensions.hidden, true);
    assert.match(loaded.warnings[0], /informational only/);
    assert.equal(loaded.resourceDetails.find((entry) => entry.path === "assets/pixel.bin")?.mediaType, "application/octet-stream");
    const readiness = await evaluateSkillReadiness(loaded, { environment: { PATH: "" }, mcpBindings: [] });
    assert.equal(readiness.find((entry) => entry.id === "missing-qi-test-command")?.available, false);
    assert.equal(readiness.find((entry) => entry.id === "browser")?.available, false);

    const catalog = new SkillCatalog({ workspaceRoot: workspace, userHome: root, userSkillsRoot: join(root, "user-skills"), compatibilityRoots: [] });
    const installed = await catalog.install({ source, scope: "workspace" });
    assert.match(installed.digest, /^sha256:/);
    const lock = JSON.parse(await readFile(join(workspace, ".qi", "skills.lock.json"), "utf8"));
    assert.equal(lock.skills["safe-demo"].digest, installed.digest);
    assert.doesNotMatch(JSON.stringify(lock), new RegExp(root.replaceAll("\\", "\\\\"), "i"));
    assert.deepEqual([...await catalog.readResource("safe-demo", "assets/pixel.bin")], [0, 255, 1, 254]);
    const result = await runSkillScript({ skillRoot: installed.root, workspaceRoot: workspace, request: { path: "scripts/help.mjs", args: ["--help"], timeoutMs: 5_000 } });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /safe-demo help/);
    await assert.rejects(() => runSkillScript({ skillRoot: installed.root, workspaceRoot: workspace, request: { path: "SKILL.md" } }), /scripts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential-free Skill and MCP JSON management commands operate without starting a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-extension-cli-"));
  try {
    const workspace = join(root, "workspace"); const source = join(root, "cli-skill");
    await mkdir(workspace); await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: cli-skill\ndescription: Installed by the JSON management command.\n---\nUse it.\n");
    const main = join(process.cwd(), "apps", "cli", "dist", "main.js");
    const environment = { ...process.env, QI_HOME: join(root, "qi-home") };
    const installed = JSON.parse((await execFileAsync(process.execPath, [main, "skills", "install", source, "--scope", "workspace", "--workspace", workspace, "--json"], { env: environment })).stdout);
    assert.equal(installed.name, "cli-skill");
    const listed = JSON.parse((await execFileAsync(process.execPath, [main, "skills", "list", "--workspace", workspace, "--json"], { env: environment })).stdout);
    assert.equal(listed[0].name, "cli-skill");
    const mcp = JSON.parse((await execFileAsync(process.execPath, [main, "mcp", "status", "--workspace", workspace, "--json"], { env: environment })).stdout);
    assert.deepEqual(mcp, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP declarations shadow by scope and reject implicit launchers, literal secrets, and unsafe private URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mcp-declarations-"));
  try {
    const workspace = join(root, "workspace");
    const user = join(root, "user-mcp");
    await mkdir(join(workspace, ".qi", "mcp"), { recursive: true });
    await mkdir(user, { recursive: true });
    await writeFile(join(user, "demo.toml"), 'transport = "http"\nurl = "https://user.example/mcp"\n');
    await writeFile(join(workspace, ".qi", "mcp", "demo.toml"), 'transport = "http"\nurl = "https://workspace.example/mcp"\n');
    const discovered = await new McpDeclarationCatalog({ workspaceRoot: workspace, userDeclarationsRoot: user }).discover();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].scope, "workspace");
    assert.equal(discovered[0].url, "https://workspace.example/mcp");
    assert.throws(() => parseDeclaration({ transport: "stdio", command: "npx", args: ["-y", "x"] }, "bad", "bad.toml", "workspace", workspace), /not allowed/);
    assert.throws(() => parseDeclaration({ transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer secret" } }, "bad", "bad.toml", "workspace", workspace), /credential or env reference/);
    assert.throws(() => parseDeclaration({ transport: "http", url: "https://192.168.1.2/mcp", allow_private_network: "yes" }, "bad", "bad.toml", "workspace", workspace), /must be boolean/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP review fingerprints quarantine drift and bind exact target resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mcp-review-"));
  try {
    const reviews = new McpReviewStore(join(root, "state", "mcp-bindings.json"));
    const raw = { name: "lookup", description: "Lookup", inputSchema: { type: "object" } };
    const first = candidateFromRaw("tool", raw);
    await reviews.recordSnapshot({ server: "demo", capturedAt: new Date().toISOString(), tools: [first], resources: [], resourceTemplates: [], prompts: [] });
    const binding = await reviews.bind({ server: "demo", kind: "tool", name: "lookup", effect: "read" });
    assert.deepEqual(binding.resourcePatterns, [mcpTargetResource("demo", "tool", "lookup")]);
    assert.equal(binding.fingerprint, fingerprintMcpValue(raw));
    const changed = candidateFromRaw("tool", { ...raw, description: "Changed" });
    const recorded = await reviews.recordSnapshot({ server: "demo", capturedAt: new Date().toISOString(), tools: [changed], resources: [], resourceTemplates: [], prompts: [] });
    assert.equal(recorded.drifted.length, 1);
    assert.equal(Object.values((await reviews.read()).bindings)[0].state, "drifted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("official MCP client negotiates stdio, discovers all capability classes, and validates schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-mcp-stdio-"));
  const workspace = join(root, "workspace");
  const declarationsRoot = join(workspace, ".qi", "mcp");
  const reviews = new McpReviewStore(join(root, "state", "reviews.json"));
  const fixture = join(process.cwd(), "tests", "fixtures", "mcp-stdio-server.mjs");
  await mkdir(declarationsRoot, { recursive: true });
  await writeFile(join(declarationsRoot, "fixture.toml"), `transport = "stdio"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\nconnect_timeout_ms = 5000\ncall_timeout_ms = 5000\n`);
  const catalog = new McpDeclarationCatalog({ workspaceRoot: workspace, userDeclarationsRoot: join(root, "user") });
  const manager = new McpConnectionManager({ catalog, reviews, workspaceRoot: workspace });
  try {
    const refreshed = await manager.refresh("fixture");
    assert.equal(refreshed.snapshot.tools[0].name, "echo");
    assert.equal(refreshed.snapshot.resources[0].name, "test://fixture");
    assert.equal(refreshed.snapshot.prompts[0].name, "hello");
    assert.match(refreshed.snapshot.instructions, /Untrusted fixture/);
    const binding = await reviews.bind({ server: "fixture", kind: "tool", name: "echo", effect: "read" });
    const result = await manager.callTool(binding, { text: "hello" });
    assert.equal(result.structuredContent.echoed, "hello");
    await assert.rejects(() => manager.callTool(binding, {}), /input schema validation/);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("official MCP client uses explicit Streamable HTTP without legacy fallback", async () => {
  const httpServer = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "qi-http-fixture" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: mcpFixtureResponse(message.method, message.params) }));
  });
  httpServer.listen(0, "127.0.0.1"); await once(httpServer, "listening");
  const port = httpServer.address().port;
  const root = await mkdtemp(join(tmpdir(), "qi-mcp-http-"));
  const workspace = join(root, "workspace"); await mkdir(join(workspace, ".qi", "mcp"), { recursive: true });
  await writeFile(join(workspace, ".qi", "mcp", "http-fixture.toml"), `transport = "http"\nurl = "http://127.0.0.1:${port}/mcp"\nconnect_timeout_ms = 5000\ncall_timeout_ms = 5000\n`);
  const reviews = new McpReviewStore(join(root, "reviews.json"));
  const manager = new McpConnectionManager({ catalog: new McpDeclarationCatalog({ workspaceRoot: workspace, userDeclarationsRoot: join(root, "user") }), reviews, workspaceRoot: workspace });
  try {
    const refreshed = await manager.refresh("http-fixture");
    assert.equal(refreshed.snapshot.tools[0].name, "echo");
    assert.equal(refreshed.snapshot.tools[1].name, "second-page");
    const status = (await manager.statuses())[0];
    assert.equal(status.transport, "http");
  } finally { await manager.close(); httpServer.close(); await once(httpServer, "close"); await rm(root, { recursive: true, force: true }); }
});

test("official MCP client supports legacy SSE only when transport is explicitly sse", async () => {
  let stream;
  let port;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/sse") {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`event: endpoint\ndata: http://127.0.0.1:${port}/messages\n\n`);
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/messages")) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(202).end();
      if (message.id !== undefined) stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: mcpFixtureResponse(message.method, message.params) })}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); port = server.address().port;
  const root = await mkdtemp(join(tmpdir(), "qi-mcp-sse-"));
  const workspace = join(root, "workspace"); await mkdir(join(workspace, ".qi", "mcp"), { recursive: true });
  await writeFile(join(workspace, ".qi", "mcp", "sse-fixture.toml"), `transport = "sse"\nurl = "http://127.0.0.1:${port}/sse"\nconnect_timeout_ms = 5000\ncall_timeout_ms = 5000\n`);
  const reviews = new McpReviewStore(join(root, "reviews.json"));
  const manager = new McpConnectionManager({ catalog: new McpDeclarationCatalog({ workspaceRoot: workspace, userDeclarationsRoot: join(root, "user") }), reviews, workspaceRoot: workspace });
  try {
    const refreshed = await manager.refresh("sse-fixture");
    assert.equal(refreshed.snapshot.tools[0].name, "echo");
    assert.equal((await manager.statuses())[0].transport, "sse");
  } finally { await manager.close(); stream?.end(); server.close(); await once(server, "close"); await rm(root, { recursive: true, force: true }); }
});

test("sealed MCP OAuth validates state, resource origin, and denies silent scope step-up", async () => {
  const records = new Map();
  const store = {
    async list() { return []; },
    async get(id) { return records.get(id); },
    async set(record) { records.set(record.accountId, structuredClone(record)); },
    async delete(id) { return records.delete(id); },
  };
  const declaration = parseDeclaration({ transport: "http", url: "https://mcp.example/api", oauth: true, oauth_redirect_url: "http://127.0.0.1:43111/callback", oauth_scopes: ["read"] }, "secure", "secure.toml", "user", process.cwd());
  const redirects = [];
  const provider = new SealedMcpOAuthProvider(store, declaration, { redirectToAuthorization(_server, url) { redirects.push(url.toString()); }, confirmAdditionalScopes() { return false; } });
  const state = await provider.state();
  await assert.rejects(() => provider.validateCallbackState("wrong"), /state mismatch/);
  await provider.validateCallbackState(state);
  await provider.saveCodeVerifier("a".repeat(43));
  assert.equal(await provider.codeVerifier(), "a".repeat(43));
  assert.equal((await provider.validateResourceURL(declaration.url, "https://mcp.example/api"))?.origin, "https://mcp.example");
  await assert.rejects(() => provider.validateResourceURL(declaration.url, "https://evil.example/api"), /origin mismatch/);
  await provider.saveTokens({ access_token: "one", token_type: "Bearer", scope: "read" });
  await assert.rejects(() => provider.saveTokens({ access_token: "two", token_type: "Bearer", scope: "read write" }), /scope step-up/);
  assert.doesNotMatch(JSON.stringify(await store.list()), /access_token|one|two/);
});

const realSkills = [
  ["find-skills", "D:/gh-ws/skill-ws/vercel-labs-skills", "1164afa5f0e21ebd01e6fc11249759353f494ad1", "skills/find-skills"],
  ["web-design-guidelines", "D:/gh-ws/skill-ws/agent-skills", "7c180d9044c9ae2b442b567aad4e42a28dd5ed62", "skills/web-design-guidelines"],
  ["frontend-design", "D:/gh-ws/skill-ws/anthropics-skills", "b29e7cf65e5cb78a5ac33d582270551bc74a14eb", "skills/frontend-design"],
  ["webapp-testing", "D:/gh-ws/skill-ws/anthropics-skills", "b29e7cf65e5cb78a5ac33d582270551bc74a14eb", "skills/webapp-testing"],
  ["mcp-builder", "D:/gh-ws/skill-ws/anthropics-skills", "b29e7cf65e5cb78a5ac33d582270551bc74a14eb", "skills/mcp-builder"],
  ["agent-browser", "D:/gh-ws/skill-ws/agent-browser", "01c1147da66940c034a5ccea497447e52c2f6dfe", "skills/agent-browser"],
];

function mcpFixtureResponse(method, params) {
  if (method === "initialize") return { protocolVersion: params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "qi-http-fixture", version: "1.0.0" }, instructions: "fixture" };
  if (method === "tools/list") return params?.cursor === "page-2"
    ? { tools: [{ name: "second-page", description: "Second", inputSchema: { type: "object" } }] }
    : { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }], nextCursor: "page-2" };
  if (method === "resources/list") return { resources: [] };
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  if (method === "prompts/list") return { prompts: [] };
  return {};
}

test("six pinned real Skills remain compatible when local reference repositories are available", async (t) => {
  for (const [name, repository, commit, subdir] of realSkills) {
    await t.test(name, async (sample) => {
      try { await access(repository); } catch { sample.skip(`local reference repository unavailable: ${repository}`); return; }
      const current = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
      assert.equal(current, commit);
      const loaded = await new SkillLoader().load(join(repository, subdir), { enforceDirectoryName: true });
      assert.equal(loaded.name, name);
      if (name === "webapp-testing") assert.ok(loaded.resources.some((entry) => entry.startsWith("scripts/")));
      if (name === "mcp-builder") assert.ok(loaded.resources.some((entry) => entry.startsWith("reference/")));
      if (name === "agent-browser") {
        assert.equal(loaded.extensions.hidden, true);
        const missing = (await evaluateSkillReadiness(loaded, { environment: { PATH: "" } })).find((entry) => entry.id === "agent-browser");
        assert.equal(missing?.available, false);
        const fakeBin = join(repository, "bin", "agent-browser.js");
        const configured = (await evaluateSkillReadiness(loaded, { environment: { PATH: "", QI_AGENT_BROWSER_BIN: fakeBin } })).find((entry) => entry.id === "agent-browser");
        assert.equal(configured?.available, true);
      }
    });
  }
});

test("agent-browser opt-in binary passes offline doctor and MCP handshake", async (t) => {
  const configured = process.env.QI_AGENT_BROWSER_BIN;
  if (!configured) { t.skip("QI_AGENT_BROWSER_BIN is not configured; Qi must not install or download it"); return; }
  await execFileAsync(configured, ["doctor", "--offline", "--quick"], { timeout: 30_000, windowsHide: true });
  const root = await mkdtemp(join(tmpdir(), "qi-agent-browser-mcp-"));
  const workspace = join(root, "workspace"); await mkdir(join(workspace, ".qi", "mcp"), { recursive: true });
  await writeFile(join(workspace, ".qi", "mcp", "agent-browser.toml"), `transport = "stdio"\ncommand = ${JSON.stringify(configured)}\nargs = ["mcp", "--tools", "core"]\nconnect_timeout_ms = 15000\ncall_timeout_ms = 60000\n`);
  const manager = new McpConnectionManager({ catalog: new McpDeclarationCatalog({ workspaceRoot: workspace, userDeclarationsRoot: join(root, "user") }), reviews: new McpReviewStore(join(root, "reviews.json")), workspaceRoot: workspace });
  try {
    const refreshed = await manager.refresh("agent-browser");
    assert.ok(refreshed.snapshot.tools.length > 0);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
