import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillCatalog, SkillLoader, loadAgentDefinition } from "@civaapple/qi-node/skills";

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

    const catalog = new SkillCatalog({ workspaceRoot: workspace, userHome: join(root, "home"), userSkillsRoot: userSkills, compatibilityRoots: [] });
    const discovered = await catalog.discover();
    assert.deepEqual(discovered.map(({ name, version, scope }) => ({ name, version, scope })), [
      { name: "shared", version: "2.0.0", scope: "workspace" },
      { name: "user-only", version: "unversioned", scope: "user" },
    ]);
    assert.equal(discovered[0].shadowedUserRoot, userShared);
    assert.match((await catalog.load("shared")).instructions, /WORKSPACE_INSTRUCTIONS/);
  });
});

test("Skill catalog installs a complete compatible Skill tree while omitting caches", async () => {
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
      userHome: join(root, "home"),
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
    assert.equal(await readFile(join(userSkills, "skill-creator", "LICENSE"), "utf8"), "license\n");
    await assert.rejects(catalog.install({ source: "skill-creator" }), /already installed/);

    const draft = join(workspace, "skill-drafts", "local-helper");
    await mkdir(draft, { recursive: true });
    await writeFile(join(draft, "SKILL.md"), "---\nname: local-helper\ndescription: Local helper\n---\nHelp locally.\n");
    const workspaceInstall = await catalog.install({ source: "skill-drafts/local-helper", scope: "workspace" });
    assert.equal(workspaceInstall.root, join(workspace, ".qi", "skills", "local-helper"));
  });
});

test("generic Agent Skills are metadata-only candidates until explicitly migrated", async () => {
  await temporary(async (root) => {
    const workspace = join(root, "workspace");
    const userSkills = join(root, "home", ".qi", "skills");
    const compatibility = join(root, "generic-agent", "skills");
    const source = join(compatibility, "external-review");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: external-review\ndescription: Review from a generic Agent directory\n---\nDo not activate until migrated.\n",
    );
    await writeFile(join(source, "references", "rules.md"), "untrusted rules\n");

    const catalog = new SkillCatalog({ workspaceRoot: workspace, userHome: join(root, "home"), userSkillsRoot: userSkills, compatibilityRoots: [compatibility] });
    const candidates = await catalog.discoverCompatibility([]);
    assert.deepEqual(candidates.map(({ name, source }) => ({ name, source })), [
      { name: "external-review", source: "compatibility" },
    ]);
    await assert.rejects(catalog.load("external-review"), /not installed/);
    await assert.rejects(catalog.readResource("external-review", "references/rules.md"), /not installed/);

    const installed = await catalog.install({ source: "external-review", scope: "user" });
    assert.equal(installed.scope, "user");
    assert.match((await catalog.load("external-review")).instructions, /Do not activate/);
    assert.deepEqual(await catalog.discoverCompatibility(), []);
    assert.equal((await catalog.discover()).some((skill) => skill.name === "external-review"), true);
  });
});

test("Workspace .agents Skills are active and global .agents Skills require activation", async () => {
  await temporary(async (root) => {
    const workspace = join(root, "workspace");
    const userHome = join(root, "home");
    const globalSkill = join(userHome, ".agents", "skills", "global-review");
    const projectSkill = join(workspace, ".agents", "skills", "project-review");
    await mkdir(globalSkill, { recursive: true });
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(globalSkill, "SKILL.md"), "---\nname: global-review\ndescription: Global Agent Skill\n---\nGlobal instructions.\n");
    await writeFile(join(projectSkill, "SKILL.md"), "---\nname: project-review\ndescription: Project Agent Skill\n---\nProject instructions.\n");
    await writeFile(join(userHome, ".agents", ".skill-lock.json"), JSON.stringify({
      version: 3,
      skills: {
        "global-review": {
          sourceType: "github",
          skillPath: "skills/global-review/SKILL.md",
          skillFolderHash: "global-review-hash",
        },
      },
    }));

    const catalog = new SkillCatalog({ workspaceRoot: workspace, userHome, userSkillsRoot: join(userHome, ".qi", "resources", "skills"), compatibilityRoots: [] });
    const discovered = await catalog.discover();
    assert.deepEqual(
      discovered.filter((skill) => skill.name.endsWith("review")).map(({ name, scope, origin }) => ({ name, scope, origin })),
      [
        { name: "project-review", scope: "workspace", origin: "agent" },
      ],
    );
    assert.equal((await catalog.discoverAgentCandidates()).some((skill) => skill.name === "global-review"), true);
    await assert.rejects(catalog.load("global-review"), /not installed/);
    await catalog.activateAgentSkill("global-review");
    assert.equal((await catalog.discover()).some((skill) => skill.name === "global-review"), true);
    assert.match((await catalog.load("global-review")).instructions, /Global instructions/);
    assert.match((await catalog.load("project-review")).instructions, /Project instructions/);
  });
});

test("Home-directory Workspace does not auto-activate the global .agents root", async () => {
  await temporary(async (root) => {
    const userHome = join(root, "home");
    const globalSkill = join(userHome, ".agents", "skills", "global-review");
    await mkdir(globalSkill, { recursive: true });
    await writeFile(join(globalSkill, "SKILL.md"), "---\nname: global-review\ndescription: Global Agent Skill\n---\nGlobal instructions.\n");
    await writeFile(join(userHome, ".agents", ".skill-lock.json"), JSON.stringify({
      version: 3,
      skills: {
        "global-review": {
          sourceType: "github",
          skillPath: "skills/global-review/SKILL.md",
          skillFolderHash: "global-review-hash",
        },
      },
    }));

    const catalog = new SkillCatalog({ workspaceRoot: userHome, userHome, userSkillsRoot: join(userHome, ".qi", "resources", "skills"), compatibilityRoots: [] });
    assert.deepEqual(await catalog.discover(), []);
    assert.deepEqual((await catalog.discoverAgentCandidates()).map((skill) => skill.name), ["global-review"]);
    await assert.rejects(catalog.load("global-review"), /not installed/);
  });
});

test("Codex and Claude Skill roots are not scanned by default", async () => {
  await temporary(async (root) => {
    const workspace = join(root, "workspace");
    const userHome = join(root, "home");
    for (const vendor of [".codex", ".claude"]) {
      const skill = join(userHome, vendor, "skills", `${vendor.slice(1)}-only`);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), `---\nname: ${vendor.slice(1)}-only\ndescription: Must be explicit\n---\nHidden by default.\n`);
    }
    const catalog = new SkillCatalog({ workspaceRoot: workspace, userHome, userSkillsRoot: join(userHome, ".qi", "resources", "skills") });
    assert.equal((await catalog.discover()).some((skill) => skill.name === "codex-only" || skill.name === "claude-only"), false);
    assert.deepEqual(await catalog.discoverCompatibility(), []);
    await assert.rejects(catalog.load("codex-only"), /not installed/);
    await assert.rejects(catalog.load("claude-only"), /not installed/);
    const migrated = await catalog.install({ source: join(userHome, ".codex", "skills", "codex-only") });
    assert.equal(migrated.name, "codex-only");
    assert.match((await catalog.load("codex-only")).instructions, /Hidden by default/);
  });
});

test("Workspace Skill draft export and digest-guarded update preserve create-only install semantics", async () => {
  await temporary(async (root) => {
    const workspace = join(root, "workspace");
    const installed = join(workspace, ".qi", "skills", "review");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "SKILL.md"),
      "---\nname: review\nversion: 1.0.0\ndescription: Review code\n---\nOriginal instructions.\n",
    );
    const catalog = new SkillCatalog({
      workspaceRoot: workspace,
      userHome: join(root, "home"),
      userSkillsRoot: join(root, "user-skills"),
      compatibilityRoots: [],
    });
    const draft = join(workspace, "skill-drafts", "review");
    const exported = await catalog.exportWorkspaceDraft("review", draft);
    assert.match(exported.expectedDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(exported.draftDigest, exported.expectedDigest);
    assert.equal(exported.fileCount, 1);
    await assert.rejects(catalog.exportWorkspaceDraft("review", draft), /already exists/);

    await writeFile(
      join(draft, "SKILL.md"),
      "---\nname: review\nversion: 1.1.0\ndescription: Review code\n---\nUpdated instructions.\n",
    );
    const updated = await catalog.updateWorkspace("review", draft, exported.expectedDigest);
    assert.notEqual(updated.digest, exported.expectedDigest);
    assert.match(await readFile(join(installed, "SKILL.md"), "utf8"), /Updated instructions/);
    await assert.rejects(
      catalog.updateWorkspace("review", draft, exported.expectedDigest),
      (error) => error?.name === "SkillStaleError",
    );
    await assert.rejects(
      catalog.install({ source: draft, scope: "workspace", expectedName: "review" }),
      /already installed/,
    );
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
