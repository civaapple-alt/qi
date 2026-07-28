import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import {
  AuthorityDeniedError,
  FileArtifactStore,
  ToolRegistry,
  createScriptTool,
  probeShellProfiles,
  resolveShellConfig,
  shellProfileResource,
  shellTool,
} from "@civaapple/qi-node/tools";

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
