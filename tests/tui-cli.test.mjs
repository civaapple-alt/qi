import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseTuiCliArguments, qiCliVersion, refreshLaunchCapabilities } from "../apps/cli/dist/cli.js";
import { defaultSessionDataRoot, workspaceProjectId } from "../apps/cli/dist/paths.js";

test("CLI help and version are credential-free", async () => {
  const help = await parseTuiCliArguments(["--help"], {
    environment: {},
    packageVersion: "9.9.9",
  });
  assert.equal(help.kind, "help");
  assert.match(help.text, /qi \[WORKSPACE\]/);
  assert.match(help.text, /current directory/);

  const version = await parseTuiCliArguments(["--version"], {
    environment: {},
    packageVersion: "9.9.9",
  });
  assert.equal(version.kind, "version");
  assert.equal(version.text, "qi 9.9.9\n");
  assert.equal(qiCliVersion("1.2.3"), "qi 1.2.3");
});

test("CLI defaults workspace to cwd; positional path is optional", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-cwd-"));
  try {
    const nested = join(root, "nested");
    await mkdir(nested);
    const bare = await parseTuiCliArguments(["--no-config"], {
      cwd: root,
      environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
    });
    assert.equal(bare.kind, "run");
    assert.equal(bare.options.workspaceRoot, resolve(root));

    const positional = await parseTuiCliArguments([nested, "--no-config"], {
      cwd: root,
      environment: { OPENAI_API_KEY: "test-key", QI_HOME: join(root, "home") },
    });
    assert.equal(positional.kind, "run");
    assert.equal(positional.options.workspaceRoot, resolve(nested));

    await assert.rejects(
      () => parseTuiCliArguments([nested, "--workspace", root, "--no-config"], {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key" },
      }),
      /positional path or --workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI treats --data as the exact data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-data-"));
  try {
    const workspace = join(root, "ws");
    const data = join(root, "custom-data");
    await mkdir(workspace);
    await mkdir(data);
    const parsed = await parseTuiCliArguments(
      ["--workspace", workspace, "--data", data, "--no-config"],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key" },
      },
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.workspaceRoot, resolve(workspace));
    assert.equal(parsed.options.dataRoot, resolve(data));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI defaults data to QI_HOME/projects/<project-id> and honors --safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-safe-"));
  try {
    const workspace = join(root, "project");
    const qiHome = join(root, "home-qi");
    await mkdir(workspace);
    const parsed = await parseTuiCliArguments(
      ["--workspace", workspace, "--no-config", "--safe"],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: qiHome },
      },
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.dataRoot, defaultSessionDataRoot(workspace, { QI_HOME: qiHome }));
    assert.match(parsed.options.dataRoot, /projects/);
    assert.equal(parsed.options.allowWrite, false);
    assert.equal(parsed.options.allowExecute, false);
    assert.equal(parsed.options.allowVerify, false);
    assert.equal(parsed.options.allowNetwork, false);
    assert.equal(parsed.options.allowBackground, false);
    assert.equal(parsed.options.allowDelegate, false);
    assert.equal(parsed.options.allowPublish, false);
    assert.equal(parsed.options.allowSpend, false);
    assert.equal(parsed.options.maxSteps, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI exposes separate publish and one-use spend policy flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-publish-spend-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const parsed = await parseTuiCliArguments(["--workspace", workspace, "--no-config", "--allow-publish", "--allow-spend"], { cwd: root, environment: { QI_HOME: join(root, "home") } });
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.allowPublish, true);
    assert.equal(parsed.options.allowSpend, true);
    await assert.rejects(() => parseTuiCliArguments(["--workspace", workspace, "--no-config", "--allow-spend", "--no-spend"], { cwd: root }), /cannot be used together/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI max_steps precedence is flag over project over user over default and enforces 8..1000", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-max-steps-"));
  try {
    const workspace = join(root, "workspace");
    const qiHome = join(root, "qi-home");
    const userConfig = join(root, "user.toml");
    await mkdir(workspace);
    await writeFile(userConfig, "version = 1\nmax_steps = 16\n");
    const projectDir = join(qiHome, "projects", workspaceProjectId(workspace));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "policy.toml"), "version = 1\nmax_steps = 24\n");
    const environment = { OPENAI_API_KEY: "test-key", QI_HOME: qiHome };

    const project = await parseTuiCliArguments(
      ["--workspace", workspace, "--config", userConfig],
      { cwd: root, environment },
    );
    assert.equal(project.kind, "run");
    assert.equal(project.options.maxSteps, 24);

    const flag = await parseTuiCliArguments(
      ["--workspace", workspace, "--config", userConfig, "--max-steps", "40"],
      { cwd: root, environment },
    );
    assert.equal(flag.kind, "run");
    assert.equal(flag.options.maxSteps, 40);

    await rm(join(projectDir, "policy.toml"));
    const user = await parseTuiCliArguments(
      ["--workspace", workspace, "--config", userConfig],
      { cwd: root, environment },
    );
    assert.equal(user.kind, "run");
    assert.equal(user.options.maxSteps, 16);
    await assert.rejects(
      () => parseTuiCliArguments(["--no-config", "--max-steps", "7"], { cwd: root, environment }),
      /8 to 1000/,
    );
    const high = await parseTuiCliArguments(
      ["--workspace", workspace, "--config", userConfig, "--max-steps", "1000"],
      { cwd: root, environment },
    );
    assert.equal(high.kind, "run");
    assert.equal(high.options.maxSteps, 1000);
    await assert.rejects(
      () => parseTuiCliArguments(["--no-config", "--max-steps", "1001"], { cwd: root, environment }),
      /8 to 1000/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace project ID includes a readable basename and path hash", () => {
  assert.match(workspaceProjectId("D:\\ai-project\\adk-agent"), /^adk-agent-[0-9a-f]{12}$/);
  assert.notEqual(
    workspaceProjectId("D:\\ai-project\\adk-agent"),
    workspaceProjectId("E:\\ai-project\\adk-agent"),
  );
});

test("CLI rejects conflicting capability flags", async () => {
  await assert.rejects(
    () => parseTuiCliArguments(["--allow-write", "--no-write", "--no-config"], {
      environment: { OPENAI_API_KEY: "test-key" },
    }),
    /cannot be used together/,
  );
  await assert.rejects(
    () => parseTuiCliArguments(["--safe", "--allow-execute", "--no-config"], {
      environment: { OPENAI_API_KEY: "test-key" },
    }),
    /--safe cannot be combined/,
  );
});

test("CLI loads project mounts and --add-dir; project capabilities overlay global", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-project-"));
  try {
    const workspace = join(root, "ws");
    const other = join(root, "other");
    const qiHome = join(root, "home");
    await mkdir(workspace);
    await mkdir(other);
    const projectId = workspaceProjectId(workspace);
    const projectDir = join(qiHome, "projects", projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "policy.toml"), [
      "version = 1",
      "",
      "[capabilities]",
      "write = true",
      "",
      "[[mounts]]",
      'id = "docs"',
      `path = ${JSON.stringify(other)}`,
      'mode = "read"',
      "",
    ].join("\n"));
    const extra = join(root, "extra");
    await mkdir(extra);
    const parsed = await parseTuiCliArguments(
      ["--workspace", workspace, "--no-config", "--add-dir", extra],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: qiHome },
      },
    );
    assert.equal(parsed.kind, "run");
    // --no-config skips global and project TOML; --add-dir still applies.
    assert.equal(parsed.options.mounts.length, 1);
    assert.equal(parsed.options.mounts[0].path, resolve(extra));
    assert.equal(parsed.options.mounts[0].source, "cli");

    const globalConfig = join(root, "global.toml");
    await writeFile(globalConfig, "version = 1\n");
    const withProject = await parseTuiCliArguments(
      ["--workspace", workspace, "--config", globalConfig, "--add-dir", extra],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: qiHome },
      },
    );
    assert.equal(withProject.kind, "run");
    assert.equal(withProject.options.allowWrite, true);
    assert.ok(withProject.options.mounts.some((mount) => mount.id === "docs" && mount.path === resolve(other)));
    assert.ok(withProject.options.mounts.some((mount) => mount.path === resolve(extra) && mount.source === "cli"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI loads capability defaults from a user config when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-config-"));
  try {
    const configPath = join(root, "config.toml");
    await writeFile(configPath, [
      "version = 1",
      "provider = \"openai\"",
      "model = \"gpt-test\"",
      "",
      "[capabilities]",
      "write = true",
      "execute = true",
      "",
    ].join("\n"));
    const parsed = await parseTuiCliArguments(
      ["--config", configPath, "--workspace", root],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key" },
      },
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.allowWrite, true);
    assert.equal(parsed.options.allowExecute, true);
    assert.equal(parsed.options.provider.model, "gpt-test");
    assert.equal(parsed.options.configPath, resolve(configPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshLaunchCapabilities picks up project TOML written after the initial parse", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-cli-refresh-caps-"));
  try {
    const qiHome = join(root, "home");
    const workspace = join(root, "ws");
    await mkdir(workspace);
    await mkdir(qiHome, { recursive: true });
    const globalConfig = join(root, "global.toml");
    await writeFile(globalConfig, "version = 1\n");
    const parsed = await parseTuiCliArguments(
      ["--workspace", workspace, "--config", globalConfig],
      {
        cwd: root,
        environment: { OPENAI_API_KEY: "test-key", QI_HOME: qiHome },
      },
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.allowWrite, false);
    assert.equal(parsed.options.allowNetwork, false);

    const projectConfig = parsed.options.projectConfigPath;
    assert.ok(projectConfig);
    await mkdir(dirname(projectConfig), { recursive: true });
    await writeFile(projectConfig, [
      "version = 1",
      "",
      "[capabilities]",
      "write = true",
      "network = true",
      "execute = true",
      "",
    ].join("\n"));

    const refreshed = await refreshLaunchCapabilities(parsed.options, {
      OPENAI_API_KEY: "test-key",
      QI_HOME: qiHome,
    });
    assert.equal(refreshed.allowWrite, true);
    assert.equal(refreshed.allowNetwork, true);
    assert.equal(refreshed.allowExecute, true);
    assert.equal(refreshed.allowVerify, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
