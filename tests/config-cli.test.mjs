import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTuiCliArguments } from "../apps/cli/dist/cli.js";
import {
  buildConfigReport,
  formatAboutLines,
  runConfigCliCommand,
} from "../apps/cli/dist/config-command.js";
import { primarySlashCommands } from "../packages/tui/dist/commands.js";

test("qi config show|validate|doctor works without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-config-cli-"));
  try {
    const workspace = join(root, "ws");
    const home = join(root, "home");
    await mkdir(workspace);
    await mkdir(join(home), { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      [
        "version = 1",
        'language = "en"',
        'provider = "openai"',
        'model = "gpt-test"',
        "",
        "[capabilities]",
        "write = true",
        "",
      ].join("\n"),
      "utf8",
    );

    const chunks = [];
    const ok = await runConfigCliCommand(
      ["config", "show", "--workspace", workspace, "--config", join(home, "config.toml")],
      {
        cwd: root,
        environment: { QI_HOME: home },
        write: (text) => chunks.push(text),
      },
    );
    assert.equal(ok, true);
    assert.match(chunks.join(""), /provider openai/);
    assert.match(chunks.join(""), /write/);

    const jsonChunks = [];
    await runConfigCliCommand(
      ["config", "validate", "--workspace", workspace, "--config", join(home, "config.toml"), "--json"],
      {
        cwd: root,
        environment: { QI_HOME: home },
        write: (text) => jsonChunks.push(text),
      },
    );
    const validated = JSON.parse(jsonChunks.join(""));
    assert.equal(validated.ok, true);

    const report = await buildConfigReport({
      workspaceRoot: workspace,
      environment: { QI_HOME: home },
      configPath: join(home, "config.toml"),
    });
    assert.equal(report.user.exists, true);
    assert.equal(report.effective.provider, "openai");
    assert.equal(report.effective.capabilities.write, true);
    assert.ok(Array.isArray(report.doctor.lines));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qi config validate fails closed on invalid TOML", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-config-bad-"));
  try {
    const bad = join(root, "bad.toml");
    await writeFile(bad, "version = 2\n", "utf8");
    const err = [];
    process.exitCode = 0;
    await runConfigCliCommand(["config", "validate", "--config", bad], {
      cwd: root,
      environment: { QI_HOME: root },
      write: () => undefined,
      writeErr: (text) => err.push(text),
    });
    assert.equal(process.exitCode, 1);
    assert.match(err.join(""), /version must be 1/);
    process.exitCode = 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("help lists config subcommand; about/doctor/new slash are primary", async () => {
  const help = await parseTuiCliArguments(["--help"], { environment: {}, packageVersion: "1.0.0" });
  assert.equal(help.kind, "help");
  assert.match(help.text, /qi config show\|validate\|doctor/);

  const names = primarySlashCommands("en").map((command) => command.name);
  for (const name of ["about", "doctor", "new", "resume", "rename", "copy-session-id"]) {
    assert.ok(names.includes(name), `missing primary slash /${name}`);
  }
});

test("formatAboutLines is credential-free", () => {
  const lines = formatAboutLines({
    version: "qi 0.7.4",
    platform: "win32 x64",
    node: "v22.19.0",
    workspace: "D:\\proj",
    sessionId: "ses_abc",
    mode: "agent",
    authStatus: "ready",
    provider: "openai",
    model: "gpt-test",
  });
  assert.match(lines.join("\n"), /ses_abc/);
  assert.doesNotMatch(lines.join("\n"), /sk-|api[_-]?key/i);
});
