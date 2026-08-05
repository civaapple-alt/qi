import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MarketplaceRegistry,
  PluginCatalog,
  PluginInstaller,
  inspectClaudePlugin,
  parseMarketplaceCatalog,
  searchMarketplacePlugins,
  convertClaudeMcpJson,
  normalizeGithubMarketplaceRepo,
} from "@civaapple/qi-node/plugins";
import { ensureQiLayout } from "@civaapple/qi-node/paths";
import { removeFixture } from "./helpers/remove-fixture.mjs";

const fixtureMarketplace = fileURLToPath(new URL("./fixtures/claude-marketplace", import.meta.url));

test("GitHub marketplace sources normalize full URLs", () => {
  assert.equal(normalizeGithubMarketplaceRepo("https://github.com/mattpocock/skills"), "mattpocock/skills");
  assert.equal(normalizeGithubMarketplaceRepo("github:mattpocock/skills.git"), "mattpocock/skills");
  assert.equal(normalizeGithubMarketplaceRepo("mattpocock/skills"), "mattpocock/skills");
  assert.equal(normalizeGithubMarketplaceRepo("https://github.com/mattpocock/skills/tree/main"), "https://github.com/mattpocock/skills/tree/main");
});

test("marketplace.json parse and search", async () => {
  const raw = JSON.parse(await readFile(join(fixtureMarketplace, ".claude-plugin", "marketplace.json"), "utf8"));
  const catalog = parseMarketplaceCatalog(raw);
  assert.equal(catalog.name, "fixture-marketplace");
  assert.equal(catalog.plugins.length, 5);
  const hits = searchMarketplacePlugins(catalog, "context7");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "context7");
  assert.equal(hits[0].source.kind, "vendored");
});

test("inspect classifies supported, partial, and unsupported plugins", async () => {
  const skill = await inspectClaudePlugin(join(fixtureMarketplace, "plugins", "frontend-design"));
  assert.equal(skill.support, "supported");
  assert.ok(skill.components.some((entry) => entry.kind === "skills"));

  const hooks = await inspectClaudePlugin(join(fixtureMarketplace, "plugins", "hooks-only"));
  assert.equal(hooks.support, "unsupported");
  assert.deepEqual(hooks.unsupportedReasons, ["hooks"]);

  const mcp = await inspectClaudePlugin(join(fixtureMarketplace, "external_plugins", "context7"));
  assert.equal(mcp.support, "supported");
  assert.ok(mcp.components.some((entry) => entry.kind === "mcp"));
});

test("marketplace registry local add + install + enable + /plugin command resolve", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const catalogDoc = await registry.loadCatalog("fixture-marketplace");
    assert.equal(catalogDoc.plugins.length, 5);

    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("fixture-marketplace", "code-review");
    assert.equal(installed.key, "code-review@fixture-marketplace");

    await assert.rejects(
      () => installer.install("fixture-marketplace", "hooks-only"),
      /no supported Qi components/,
    );

    const plugins = new PluginCatalog(qiHome, registry, installer);
    await plugins.enable(installed.key);
    const commands = await plugins.listCommands("review");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].id, "fixture-marketplace:code-review:code-review");
    const loaded = await plugins.loadCommandBody("fixture-marketplace:code-review:code-review");
    assert.match(loaded.body, /Review the pull request/);
    assert.equal(loaded.digest.length, 64);
  } finally {
    await removeFixture(qiHome);
  }
});

test("manifest-declared nested Skills are selected independently and preserve invocation policy", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-skill-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("fixture-marketplace", "frontend-design");
    const plugins = new PluginCatalog(qiHome, registry, installer);
    await plugins.enable(installed.key);
    const commands = await plugins.listCommands();
    assert.equal(commands.length, 0);
    const statuses = await plugins.listInstalledSkills();
    assert.deepEqual(statuses.map((entry) => entry.ref.name), ["frontend-design", "model-review"]);
    assert.equal(statuses[0].ref.invocationMode, "user-only");
    assert.equal(statuses[1].ref.invocationMode, "model-only");
    await plugins.enableSkill("fixture-marketplace:frontend-design:frontend-design");
    const selected = await plugins.listSkills();
    assert.deepEqual(selected.map((entry) => entry.id), ["fixture-marketplace:frontend-design:frontend-design"]);
    await assert.rejects(
      () => plugins.resolveModelSkill(installed.key, "frontend-design"),
      /model-invocable/,
    );
    await plugins.enableSkill("fixture-marketplace:frontend-design:model-review");
    const modelSkill = await plugins.resolveModelSkill(installed.key, "model-review");
    assert.equal(modelSkill.invocationMode, "model-only");
  } finally {
    await removeFixture(qiHome);
  }
});

test("catalog supports the TUI add → install → enable plugin flow", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-tui-flow-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    const installer = new PluginInstaller(qiHome, registry);
    const plugins = new PluginCatalog(qiHome, registry, installer);
    const marketplace = await plugins.addMarketplace("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    assert.equal(marketplace.name, "fixture-marketplace");
    const disabled = await plugins.setMarketplaceEnabled(marketplace.name, false);
    assert.equal(disabled.enabled, false);
    await assert.rejects(() => plugins.searchMarketplace(marketplace.name, ""), /disabled/);
    await plugins.setMarketplaceEnabled(marketplace.name, true);
    const installed = await plugins.installMarketplacePlugin("fixture-marketplace", "frontend-design");
    assert.equal(installed.record.key, "frontend-design@fixture-marketplace");
    assert.deepEqual(await plugins.listEnabled(), []);
    await plugins.enable(installed.record.key);
    assert.deepEqual(await plugins.listEnabled(), [installed.record.key]);
    await plugins.setMarketplaceEnabled(marketplace.name, false);
    assert.deepEqual(await plugins.listEnabled(), []);
    assert.equal((await plugins.listInstalled()).some((record) => record.key === installed.record.key), true);
    await plugins.setMarketplaceEnabled(marketplace.name, true);
    assert.deepEqual(await plugins.listEnabled(), []);
  } finally {
    await removeFixture(qiHome);
  }
});

test("legacy whole-plugin enablement migrates to selected Skills and pin changes require reconfirmation", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-enable-migration-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("fixture-marketplace", "frontend-design");
    const enabledPath = join(qiHome, "plugins", "enabled.json");
    await writeFile(enabledPath, JSON.stringify({ schemaVersion: 1, plugins: { [installed.key]: true } }), "utf8");
    const plugins = new PluginCatalog(qiHome, registry, installer);
    const migrated = await plugins.listInstalledSkills();
    assert.ok(migrated.every((entry) => entry.selected && entry.enabled));

    await writeFile(enabledPath, JSON.stringify({
      schemaVersion: 2,
      plugins: { [installed.key]: { enabled: true, acceptedPin: "changed-pin", skills: ["frontend-design"] } },
    }), "utf8");
    const reconfirmation = await plugins.listInstalledSkills();
    assert.equal(reconfirmation.find((entry) => entry.ref.name === "frontend-design")?.blockedReason, "pin-confirmation");
    assert.deepEqual(await plugins.listEnabled(), []);
  } finally {
    await removeFixture(qiHome);
  }
});

test("MCP conversion writes inert declarations without binding", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-mcp-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("fixture-marketplace", "context7");
    const written = await installer.materializeMcpDeclarations(installed.key);
    assert.equal(written.length, 1);
    assert.match(written[0].replaceAll("\\", "/"), /resources\/mcp\/fixture-marketplace\/context7\.json$/);
    const body = JSON.parse(await readFile(written[0], "utf8"));
    assert.equal(body.name, "context7");
    assert.equal(body.transport, "stdio");
    assert.equal(body.command, "npx");
    assert.deepEqual(body.args, ["-y", "@upstash/context7-mcp"]);
    assert.equal(body.connect_timeout_ms, 60_000);

    const http = await convertClaudeMcpJson({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
      },
    }, "github");
    assert.equal(http[0].transport, "http");
    assert.equal(http[0].headers.Authorization, "Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}");
  } finally {
    await removeFixture(qiHome);
  }
});

test("enabled agents are searchable for /agent:", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-agent-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("fixture-marketplace", "review-agents");
    const plugins = new PluginCatalog(qiHome, registry, installer);
    await plugins.enable(installed.key);
    const agents = await plugins.listAgents("reviewer");
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "fixture-marketplace:review-agents:code-reviewer");
    const loaded = await plugins.loadAgentBody("fixture-marketplace:review-agents:code-reviewer");
    assert.match(loaded.body, /careful code reviewer/);
  } finally {
    await removeFixture(qiHome);
  }
});

test("agent list tolerates Claude unquoted description with nested Key: value text", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-plugins-agent-yaml-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("fixture-marketplace", "review-agents");
    const plugins = new PluginCatalog(qiHome, registry, installer);
    await plugins.enable(installed.key);
    const agents = await plugins.listAgents();
    assert.equal(agents.length, 2);
    const hunter = agents.find((entry) => entry.name === "silent-failure-hunter");
    assert.ok(hunter);
    assert.match(hunter.description, /silent failures/);
    assert.match(hunter.description, /Context: Daisy/);
  } finally {
    await removeFixture(qiHome);
  }
});
