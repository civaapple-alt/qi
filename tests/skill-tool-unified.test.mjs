import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MarketplaceRegistry, PluginCatalog, PluginInstaller } from "@civaapple/qi-node/plugins";
import { SkillCatalog } from "@civaapple/qi-node/skills";
import { ensureQiLayout } from "@civaapple/qi-node/paths";
import { createTuiSkillTool } from "../apps/cli/dist/skill-tool.js";
import { removeFixture } from "./helpers/remove-fixture.mjs";

const fixtureMarketplace = fileURLToPath(new URL("./fixtures/claude-marketplace", import.meta.url));

test("skill.list returns native and enabled model-invocable plugin Skills together", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-skill-unified-"));
  try {
    const qiHome = join(root, "home", ".qi");
    await ensureQiLayout(qiHome);
    const workspace = join(root, "workspace");
    const skillRoot = join(workspace, ".qi", "skills", "workspace-demo");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: workspace-demo\ndescription: Native workspace skill\n---\nDo native work.\n",
      "utf8",
    );

    const skills = new SkillCatalog({
      workspaceRoot: workspace,
      userHome: join(root, "home"),
      userSkillsRoot: join(qiHome, "resources", "skills"),
    });
    const registry = new MarketplaceRegistry(qiHome);
    await registry.add("fixture-marketplace", { kind: "local", path: fixtureMarketplace });
    const installer = new PluginInstaller(qiHome, registry);
    const plugins = new PluginCatalog(qiHome, registry, installer);
    const installed = await plugins.installMarketplacePlugin("fixture-marketplace", "frontend-design");
    await plugins.enable(installed.record.key);

    const tool = createTuiSkillTool(skills, workspace, plugins);
    const listed = await tool.execute({ operation: "list" }, {});
    assert.ok(Array.isArray(listed.skills));
    const native = listed.skills.find((entry) => entry.origin === "qi" && entry.name === "workspace-demo");
    assert.ok(native, "native workspace skill should appear");
    const pluginModel = listed.skills.find((entry) => entry.origin === "plugin" && entry.name === "model-review");
    assert.ok(pluginModel, "model-invocable plugin skill should appear");
    assert.equal(pluginModel.pluginKey, "frontend-design@fixture-marketplace");
    const pluginUserOnly = listed.skills.find((entry) => entry.origin === "plugin" && entry.name === "frontend-design");
    assert.equal(pluginUserOnly, undefined, "user-only plugin skills stay out of model list");

    const loaded = await tool.execute({
      operation: "load",
      name: "model-review",
      pluginKey: "frontend-design@fixture-marketplace",
    }, {});
    assert.equal(loaded.origin, "plugin");
    assert.match(loaded.instructions ?? "", /./);

    const byShort = await tool.execute({ operation: "load", name: "model-review" }, {});
    assert.equal(byShort.origin, "plugin");
    assert.equal(byShort.pluginKey, "frontend-design@fixture-marketplace");
  } finally {
    await removeFixture(root);
  }
});
