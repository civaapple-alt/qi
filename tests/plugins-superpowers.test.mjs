import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MarketplaceRegistry,
  PluginCatalog,
  PluginInstaller,
  loadSuperpowersBootstrap,
  SUPERPOWERS_BOOTSTRAP_RELATIVE_PATH,
  SUPERPOWERS_BOOTSTRAP_SKILL,
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
    for (const skill of ["brainstorming", "subagent-driven-development", "using-superpowers"]) {
      await catalog.enableSkill(`superpowers-marketplace:superpowers:${skill}`);
    }
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
    await catalog.setMarketplaceEnabled("superpowers-marketplace", false);
    assert.deepEqual(await catalog.listEnabled(), []);
    assert.equal((await catalog.listInstalled()).some((record) => record.key === "superpowers@superpowers-marketplace"), true);
    await catalog.setMarketplaceEnabled("superpowers-marketplace", true);
    assert.deepEqual(await catalog.listEnabled(), []);
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

test("Superpowers bootstrap uses structural skill path checks without commit/version pin", async () => {
  const bootstrap = await loadSuperpowersBootstrap({
    key: "superpowers@superpowers-marketplace",
    marketplace: "superpowers-marketplace",
    name: "superpowers",
    pin: "floating-or-local-pin",
    cachePath: fixture,
    installedAt: new Date(0).toISOString(),
    sourceKind: "vendored",
    sourceUrl: "https://github.com/obra/superpowers.git",
    commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    version: "9.9.9",
  });
  assert.ok(bootstrap);
  assert.equal(bootstrap.bootstrapSkill, SUPERPOWERS_BOOTSTRAP_SKILL);
  assert.equal(bootstrap.bootstrapPath, SUPERPOWERS_BOOTSTRAP_RELATIVE_PATH);
  assert.equal(bootstrap.commit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(bootstrap.version, "9.9.9");
  assert.match(bootstrap.instructions, /plugin_skill/);
  assert.match(bootstrap.instructions, /Use plugin skills before acting/);

  // Non-superpowers name is ignored (no bootstrap attempt).
  assert.equal(await loadSuperpowersBootstrap({
    key: "other@m",
    marketplace: "m",
    name: "other",
    pin: "x",
    cachePath: fixture,
    installedAt: new Date(0).toISOString(),
    sourceKind: "vendored",
  }), undefined);

  // Missing bootstrap Skill fails closed with a structural error.
  const brokenRoot = await mkdtemp(join(tmpdir(), "qi-superpowers-broken-"));
  try {
    await mkdir(join(brokenRoot, ".claude-plugin"), { recursive: true });
    await writeFile(join(brokenRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "superpowers",
      version: "1.0.0",
    }), "utf8");
    await assert.rejects(
      () => loadSuperpowersBootstrap({
        key: "superpowers@broken",
        marketplace: "broken",
        name: "superpowers",
        pin: "x",
        cachePath: brokenRoot,
        installedAt: new Date(0).toISOString(),
        sourceKind: "vendored",
      }),
      /using-superpowers|bootstrap Skill is missing/,
    );
  } finally {
    await removeFixture(brokenRoot);
  }
});
