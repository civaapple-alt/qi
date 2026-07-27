import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillCatalog, SkillLoader, loadAgentDefinition } from "@civaapple/qi-skills";

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-skills-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("Skill discovery reads metadata while resources remain progressively disclosed", async () => {
  await temporary(async (root) => {
    const skill = join(root, "skills", "analysis");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: analysis\nversion: 1.0.0\ndescription: Careful analysis\n---\nRead references only when needed.\n");
    await writeFile(join(skill, "references", "large.txt"), "private reference");
    const loader = new SkillLoader();
    const summaries = await loader.discover(join(root, "skills"));
    assert.deepEqual(summaries.map(({ name, version, description }) => ({ name, version, description })), [
      { name: "analysis", version: "1.0.0", description: "Careful analysis" },
    ]);
    assert.equal("instructions" in summaries[0], false);
    const loaded = await loader.load(skill);
    assert.match(loaded.instructions, /Read references/);
    assert.deepEqual(loaded.resources, ["references/large.txt"]);
    assert.equal(Buffer.from(await loader.readResource(loaded, "references/large.txt")).toString(), "private reference");
    await assert.rejects(loader.readResource(loaded, "../outside.txt"), /must be under|escapes/);
  });
});

test("Skill loader rejects missing frontmatter and roots that are symbolic links", async (t) => {
  await temporary(async (root) => {
    const skill = join(root, "real");
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "no metadata");
    await assert.rejects(new SkillLoader().load(skill), /frontmatter/);
    await writeFile(join(skill, "SKILL.md"), "---\nname: x\nversion: 1\ndescription: x\n---\nbody");
    const link = join(root, "linked");
    try { await symlink(skill, link, "junction"); } catch (error) {
      if (error?.code === "EPERM") return t.diagnostic("Symlink creation is unavailable");
      throw error;
    }
    await assert.rejects(new SkillLoader().load(link), /symbolic link/);
  });
});

test("Skill catalog merges user and Workspace scopes with Workspace precedence", async () => {
  await temporary(async (root) => {
    const workspace = join(root, "workspace");
    const userSkills = join(root, "home", ".qi", "skills");
    const userShared = join(userSkills, "shared");
    const userOnly = join(userSkills, "user-only");
    const workspaceShared = join(workspace, ".qi", "skills", "shared");
    await mkdir(userShared, { recursive: true });
    await mkdir(userOnly, { recursive: true });
    await mkdir(workspaceShared, { recursive: true });
    await writeFile(join(userShared, "SKILL.md"), "---\nname: shared\ndescription: User copy\n---\nUSER_INSTRUCTIONS\n");
    await writeFile(join(userOnly, "SKILL.md"), "---\nname: user-only\ndescription: User-only Skill\n---\nUSER_ONLY\n");
    await writeFile(join(workspaceShared, "SKILL.md"), "---\nname: shared\nversion: 2.0.0\ndescription: Workspace copy\n---\nWORKSPACE_INSTRUCTIONS\n");

    const catalog = new SkillCatalog({ workspaceRoot: workspace, userSkillsRoot: userSkills, compatibilityRoots: [] });
    const discovered = await catalog.discover();
    assert.deepEqual(discovered.map(({ name, version, scope }) => ({ name, version, scope })), [
      { name: "shared", version: "2.0.0", scope: "workspace" },
      { name: "user-only", version: "unversioned", scope: "user" },
    ]);
    assert.equal(discovered[0].shadowedUserRoot, userShared);
    assert.match((await catalog.load("shared")).instructions, /WORKSPACE_INSTRUCTIONS/);
  });
});

test("Skill catalog installs a compatible local Skill atomically and omits caches", async () => {
  await temporary(async (root) => {
    const workspace = join(root, "workspace");
    const userSkills = join(root, "home", ".qi", "skills");
    const compatibility = join(root, "compatibility");
    const source = join(compatibility, ".system", "skill-creator");
    await mkdir(join(source, "scripts", "__pycache__"), { recursive: true });
    await mkdir(join(source, "agents"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: skill-creator\ndescription: Create effective Skills\n---\nFollow the creation workflow.\n");
    await writeFile(join(source, "scripts", "init.py"), "print('init')\n");
    await writeFile(join(source, "scripts", "__pycache__", "init.pyc"), "cache");
    await writeFile(join(source, "agents", "openai.yaml"), "name: skill-creator\n");
    await writeFile(join(source, "LICENSE"), "license\n");

    const catalog = new SkillCatalog({
      workspaceRoot: workspace,
      userSkillsRoot: userSkills,
      compatibilityRoots: [compatibility],
    });
    const installed = await catalog.install({ source: "skill-creator" });
    assert.deepEqual(
      { name: installed.name, version: installed.version, scope: installed.scope },
      { name: "skill-creator", version: "unversioned", scope: "user" },
    );
    assert.equal(await readFile(join(userSkills, "skill-creator", "scripts", "init.py"), "utf8"), "print('init')\n");
    assert.equal(await readFile(join(userSkills, "skill-creator", "agents", "openai.yaml"), "utf8"), "name: skill-creator\n");
    await assert.rejects(access(join(userSkills, "skill-creator", "scripts", "__pycache__", "init.pyc")));
    await assert.rejects(catalog.install({ source: "skill-creator" }), /already installed/);

    const draft = join(workspace, "skill-drafts", "local-helper");
    await mkdir(draft, { recursive: true });
    await writeFile(join(draft, "SKILL.md"), "---\nname: local-helper\ndescription: Local helper\n---\nHelp locally.\n");
    const workspaceInstall = await catalog.install({ source: "skill-drafts/local-helper", scope: "workspace" });
    assert.equal(workspaceInstall.root, join(workspace, ".qi", "skills", "local-helper"));
  });
});

test("Agent definition is declarative and never executes agent.ts", async () => {
  await temporary(async (root) => {
    const agent = join(root, "agents", "researcher");
    await mkdir(join(agent, "evals"), { recursive: true });
    await writeFile(join(agent, "agent.md"), "---\nname: researcher\nversion: 2\ndefault_model: model-x\nmemory_scope: project\n---\nVerify before claiming completion.\n");
    await writeFile(join(agent, "agent.ts"), "throw new Error('must never execute');\n");
    await writeFile(join(agent, "evals", "quality.json"), "{}");
    const definition = await loadAgentDefinition(agent);
    assert.equal(definition.name, "researcher");
    assert.match(definition.constitution, /Verify before/);
    assert.equal(definition.dynamicConfigPath, join(agent, "agent.ts"));
    assert.deepEqual(definition.evals, ["evals/quality.json"]);
    assert.equal(await readFile(definition.dynamicConfigPath, "utf8"), "throw new Error('must never execute');\n");
  });
});
