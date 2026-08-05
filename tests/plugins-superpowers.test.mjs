import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MarketplaceRegistry,
  PluginCatalog,
  PluginInstaller,
  loadSuperpowersBootstrap,
  SUPERPOWERS_COMMIT,
} from "@civaapple/qi-node/plugins";
import { ensureQiLayout } from "@civaapple/qi-node/paths";
import { removeFixture } from "./helpers/remove-fixture.mjs";

const fixture = fileURLToPath(new URL("./fixtures/superpowers-marketplace", import.meta.url));

test("Superpowers-style marketplace installs Skills and supports the plugin Skill catalog", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-superpowers-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("superpowers-marketplace", { kind: "local", path: fixture });
    const installer = new PluginInstaller(qiHome, registry);
    const installed = await installer.install("superpowers-marketplace", "superpowers");
    const catalog = new PluginCatalog(qiHome, registry, installer);
    await catalog.enable(installed.key);
    const skills = await catalog.listSkills();
    assert.deepEqual(skills.map((entry) => entry.name), ["brainstorming", "subagent-driven-development", "using-superpowers"]);
    const loaded = await catalog.loadSkill(installed.key, "brainstorming");
    assert.match(loaded.body, /Ask questions/);
    assert.equal(new TextDecoder().decode(await catalog.readSkillResource(installed.key, "subagent-driven-development", "scripts/task-brief")), "#!/usr/bin/env bash\nprintf 'brief\\n'\n");
    assert.doesNotThrow(() => resolve(installed.cachePath, ".qi-plugin-install.json"));
    const marker = JSON.parse(await readFile(join(installed.cachePath, ".qi-plugin-install.json"), "utf8"));
    assert.equal(marker.declaredMarketplace, "superpowers-dev");
    assert.match(marker.treeDigest, /^[0-9a-f]{64}$/);
    assert.equal(installed.treeDigest, marker.treeDigest);
  } finally {
    await removeFixture(qiHome);
  }
});

test("same plugin cannot be enabled from two marketplaces at once", async () => {
  const qiHome = await mkdtemp(join(tmpdir(), "qi-superpowers-conflict-"));
  try {
    await ensureQiLayout(qiHome);
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("one", { kind: "local", path: fixture });
    await registry.add("two", { kind: "local", path: fixture });
    const installer = new PluginInstaller(qiHome, registry);
    const first = await installer.install("one", "superpowers");
    const second = await installer.install("two", "superpowers");
    const catalog = new PluginCatalog(qiHome, registry, installer);
    await catalog.enable(first.key);
    await assert.rejects(() => catalog.enable(second.key), /already enabled as superpowers@one/);
    await catalog.disable(first.key);
    await catalog.enable(second.key);
  } finally {
    await removeFixture(qiHome);
  }
});

test("canonical Superpowers bootstrap is provenance-bound", async () => {
  const bootstrap = await loadSuperpowersBootstrap({
    key: "superpowers@superpowers-marketplace",
    marketplace: "superpowers-marketplace",
    name: "superpowers",
    pin: SUPERPOWERS_COMMIT,
    cachePath: fixture,
    installedAt: new Date(0).toISOString(),
    sourceKind: "vendored",
    sourceUrl: "https://github.com/obra/superpowers.git",
    commit: SUPERPOWERS_COMMIT,
    version: "6.2.0",
  });
  assert.ok(bootstrap);
  assert.match(bootstrap.instructions, /plugin_skill/);
  assert.equal(await loadSuperpowersBootstrap({
    key: "superpowers@other",
    marketplace: "other",
    name: "superpowers",
    pin: "main",
    cachePath: fixture,
    installedAt: new Date(0).toISOString(),
    sourceKind: "vendored",
    sourceUrl: "https://github.com/obra/superpowers.git",
    commit: "main",
    version: "6.2.0",
  }), undefined);
});
