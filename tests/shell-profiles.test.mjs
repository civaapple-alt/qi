import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import {
  AuthorityDeniedError,
  FileArtifactStore,
  ToolRegistry,
  createScriptTool,
  detectInstalledShellProfiles,
  platformShellCandidates,
  probeShellProfiles,
  resolveShellConfig,
  shellProfileResource,
  shellTool,
} from "@civaapple/qi-node/tools";

const execFileAsync = promisify(execFile);

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-shell-profile-"));
  const artifacts = join(root, ".artifacts");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(artifacts, { recursive: true }));
  try {
    await run({ root, artifactStore: new FileArtifactStore(artifacts) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(root, artifactStore, actionId = "act_script_001") {
  return {
    sessionId: "ses_script_001",
    runId: "run_script_001",
    stepId: "stp_script_001",
    actionId,
    subject: "agent_main",
    workspaceRoot: root,
    artifactStore,
  };
}

test("resolveShellConfig defaults to direct-only when execute is enabled", () => {
  assert.deepEqual(resolveShellConfig(undefined, true), {
    default: "direct",
    allowed: ["direct"],
  });
  assert.deepEqual(resolveShellConfig(undefined, false), {
    default: "direct",
    allowed: [],
  });
  assert.deepEqual(
    resolveShellConfig({ default: "pwsh", allowed: ["direct", "pwsh"] }, true),
    { default: "pwsh", allowed: ["direct", "pwsh"] },
  );
  assert.throws(
    () => resolveShellConfig({ default: "bash", allowed: ["direct"] }, true),
    /listed in shell\.allowed/,
  );
});

test("platformShellCandidates and detectInstalledShellProfiles prefer installed OS shells", async () => {
  assert.deepEqual(platformShellCandidates("win32"), ["pwsh", "cmd"]);
  assert.deepEqual(platformShellCandidates("linux"), ["bash", "pwsh"]);
  assert.deepEqual(platformShellCandidates("darwin"), ["bash", "pwsh"]);
  await withWorkspace(async ({ root }) => {
    const detected = await detectInstalledShellProfiles(root);
    assert.equal(detected.default, "direct");
    assert.ok(detected.allowed.includes("direct"));
    for (const id of detected.allowed) {
      if (id === "direct") continue;
      assert.ok(
        platformShellCandidates().includes(id),
        `unexpected auto-enabled profile ${id}`,
      );
    }
  });
});

test("formatCmdVersionLabel extracts Windows build from localized or mojibake ver output", async () => {
  const { formatCmdVersionLabel } = await import("@civaapple/qi-node/tools");
  assert.equal(
    formatCmdVersionLabel("Microsoft Windows [版本 10.0.26200.8875]"),
    "Windows 10.0.26200.8875",
  );
  assert.equal(
    formatCmdVersionLabel("Microsoft Windows [\uFFFD\uFFFD\uFFFD 10.0.26200.8875]"),
    "Windows 10.0.26200.8875",
  );
  assert.equal(formatCmdVersionLabel("Microsoft Windows [Version 10.0.19045.3803]"), "Windows 10.0.19045.3803");
  assert.equal(formatCmdVersionLabel("no version here"), undefined);
});

test("formatCmdScriptContents normalizes CRLF and detects non-ASCII", async () => {
  const { formatCmdScriptContents, cmdScriptHasNonAscii } = await import("@civaapple/qi-node/tools");
  assert.equal(formatCmdScriptContents("git status\n@echo done\n"), "git status\r\n@echo done\r\n");
  assert.equal(cmdScriptHasNonAscii('git commit -m "ascii"'), false);
  assert.equal(cmdScriptHasNonAscii('git commit -m "docs: 新增进度"'), true);
});

test("probeShellProfiles marks disallowed profiles and keeps direct separate", async () => {
  await withWorkspace(async ({ root }) => {
    const snapshot = await probeShellProfiles(root, {
      default: "direct",
      allowed: ["direct", "pwsh", "cmd", "bash"],
    });
    assert.equal(snapshot.directEnabled, true);
    assert.equal(snapshot.default, "direct");
    for (const profile of snapshot.unavailable) {
      assert.notEqual(profile.id, "direct");
    }
    const disallowed = await probeShellProfiles(root, {
      default: "pwsh",
      allowed: ["pwsh"],
    });
    assert.equal(disallowed.directEnabled, false);
    assert.ok(disallowed.unavailable.some((item) => item.id === "direct" && item.status === "disallowed"));
  });
});

test("script tool runs an available profile and refuses unauthorized profiles", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    const snapshot = await probeShellProfiles(root, {
      default: "direct",
      allowed: process.platform === "win32" ? ["direct", "pwsh", "cmd"] : ["direct", "bash", "pwsh"],
    });
    if (snapshot.available.length === 0) {
      assert.ok(snapshot.unavailable.length > 0);
      return;
    }
    const profile = snapshot.available[0];
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_script",
      subject: "agent_main",
      tools: ["script"],
      effects: ["execute"],
      resources: ["host-workspace:**", shellProfileResource(profile.id)],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("script", createScriptTool(snapshot.available));
    const identity = registry.catalog().find((entry) => entry.name === "script")?.identity;
    assert.ok(identity);

    const script = profile.id === "cmd"
      ? "@echo script-ok"
      : profile.id === "bash"
        ? "printf 'script-ok'"
        : "Write-Output 'script-ok'";
    const settlement = await registry.execute(
      "script",
      identity,
      { profile: profile.id, script, workdir: ".", timeoutMs: 10_000 },
      context(root, artifactStore),
    );
    assert.equal(settlement.output.profile, profile.id);
    assert.equal(settlement.output.exitCode, 0);
    assert.match(settlement.output.stdout, /script-ok/);

    const deniedBroker = new InMemoryCapabilityBroker();
    deniedBroker.grant({
      leaseId: "lea_script_direct_only",
      subject: "agent_main",
      tools: ["shell", "script"],
      effects: ["execute"],
      resources: ["host-process:**", "host-workspace:**", shellProfileResource("direct")],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const deniedRegistry = new ToolRegistry(deniedBroker);
    deniedRegistry.register("shell", shellTool);
    deniedRegistry.register("script", createScriptTool(snapshot.available));
    const deniedIdentity = deniedRegistry.catalog().find((entry) => entry.name === "script")?.identity;
    await assert.rejects(
      deniedRegistry.execute(
        "script",
        deniedIdentity,
        { profile: profile.id, script, workdir: "." },
        context(root, artifactStore, "act_script_denied"),
      ),
      (error) => error instanceof AuthorityDeniedError,
    );

    if (profile.id !== "cmd") {
      const largeOutputScript = profile.id === "bash"
        ? "printf 'A%.0s' $(seq 1 200000)"
        : "Write-Output (\"A\" * 200000)";
      const largeRun = await registry.execute(
        "script",
        identity,
        { profile: profile.id, script: largeOutputScript, workdir: ".", timeoutMs: 20_000 },
        context(root, artifactStore, "act_script_large_output"),
      );
      if (largeRun.output.truncated) {
        assert.match(largeRun.output.outputRef, /^artifact:\/\/[a-f0-9]{64}$/);
        const stored = await artifactStore.get(largeRun.output.outputRef);
        const storedText = Buffer.from(stored.content).toString("utf8");
        assert.match(storedText, /A{200000}/);
      }
    }
  });
});

test("cmd script profile preserves Chinese git commit -m via ANSI re-encoding", async (t) => {
  if (process.platform !== "win32") {
    t.skip("cmd profile encoding is Windows-specific");
    return;
  }
  await withWorkspace(async ({ root, artifactStore }) => {
    const snapshot = await probeShellProfiles(root, {
      default: "direct",
      allowed: ["direct", "cmd"],
    });
    const cmd = snapshot.available.find((profile) => profile.id === "cmd");
    if (!cmd) {
      t.skip("cmd profile unavailable");
      return;
    }
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "qi@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Qi Test"], { cwd: root });
    await writeFile(join(root, "note.txt"), "fixture\n");
    await execFileAsync("git", ["add", "note.txt"], { cwd: root });

    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_cmd_commit",
      subject: "agent_main",
      tools: ["script"],
      effects: ["execute"],
      resources: ["host-workspace:**", shellProfileResource("cmd")],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("script", createScriptTool(snapshot.available));
    const identity = registry.catalog().find((entry) => entry.name === "script")?.identity;
    assert.ok(identity);

    const message = "docs: 新增进度文档";
    const settlement = await registry.execute(
      "script",
      identity,
      {
        profile: "cmd",
        script: `git commit -m "${message}"`,
        workdir: ".",
        timeoutMs: 20_000,
      },
      context(root, artifactStore, "act_cmd_commit_utf8"),
    );
    assert.equal(settlement.output.exitCode, 0, settlement.output.stderr || settlement.output.stdout);

    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%B"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(stdout.trim(), message);
  });
});
