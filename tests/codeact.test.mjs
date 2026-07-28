import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-capability";
import {
  CodeActRunner,
  ContainerProgramSandbox,
  ControlledToolClient,
  FixtureProgramSandbox,
  buildContainerInvocation,
  probeContainerRuntime,
} from "@civaapple/qi-codeact";
import { InMemoryEventStore } from "@civaapple/qi-kernel";
import { EventWriter } from "@civaapple/qi-loop";
import { FileArtifactStore, ToolRegistry, artifactTool, readTool, searchTool } from "@civaapple/qi-tools";

async function setup(run, grant = true) {
  const root = await mkdtemp(join(tmpdir(), "qi-codeact-test-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts);
  await writeFile(join(root, "facts.txt"), "alpha\ntarget: qi\nomega\n");
  const store = new InMemoryEventStore();
  const broker = new InMemoryCapabilityBroker();
  if (grant) broker.grant({ leaseId: "lea_codeact_001", subject: "agent_script", tools: ["search", "read", "artifact"], effects: ["read", "write"], resources: ["tree:**", "file:**", "artifact-store:**"], expiresAt: "2099-01-01T00:00:00.000Z", maxUses: 20 });
  const registry = new ToolRegistry(broker);
  registry.register("search", searchTool); registry.register("read", readTool); registry.register("artifact", artifactTool);
  const sessionId = "ses_codeact_001", runId = "run_codeact_001", stepId = "stp_codeact_001";
  const writer = new EventWriter(store, sessionId);
  writer.append("session.created", {}, { kind: "user", id: "user" });
  writer.append("run.triggered", { runId, trigger: "user" }, { kind: "user", id: "user" });
  writer.append("run.started", { runId }, { kind: "runtime", id: "qi" });
  writer.append("step.started", { runId, stepId }, { kind: "runtime", id: "qi" });
  const client = new ControlledToolClient({ store, registry, sessionId, runId, stepId, subject: "agent_script", workspaceRoot: root, artifactStore: new FileArtifactStore(artifacts) });
  try { await run({ root, store, client }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("CodeAct reruns a short data program while every nested action has durable authority and result events", async () => {
  await setup(async ({ store, client }) => {
    const program = new FixtureProgramSandbox(async (api) => {
      const found = await api.call("search", { query: "target:", path: "." });
      assert.equal(found.ok, true);
      const path = found.output.matches[0].path;
      const read = await api.call("read", { path });
      assert.equal(read.ok, true);
      const artifact = await api.call("artifact", { content: read.output.content, mediaType: "text/plain" });
      assert.equal(artifact.ok, true);
      return { path, ref: artifact.output.ref };
    });
    const runner = new CodeActRunner(client);
    const first = await runner.run(program);
    const second = await runner.run(program);
    assert.deepEqual(second, first);
    const events = store.read("ses_codeact_001").events;
    for (const type of ["action.proposed", "authority.requested", "authority.granted", "action.started", "action.completed"]) {
      assert.equal(events.filter((event) => event.type === type).length, 6, type);
    }
    assert.equal(new Set(events.filter((event) => event.type === "action.proposed").map((event) => event.data.actionId)).size, 6);
  });
});

test("CodeAct denial is structured, durable, and never enters a tool executor", async () => {
  await setup(async ({ store, client }) => {
    const result = await client.call("read", { path: "facts.txt" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "AuthorityDeniedError");
    const types = store.read("ses_codeact_001").events.map((event) => event.type);
    assert.ok(types.includes("action.proposed"));
    assert.ok(types.includes("authority.denied"));
    assert.equal(types.includes("action.started"), false);
    assert.equal(types.includes("action.completed"), false);
  }, false);
});

test("ControlledToolClient allowlist rejects a disallowed tool before any inspection or Session event", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-codeact-allowlist-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts);
  try {
    const store = new InMemoryEventStore();
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_codeact_allowlist",
      subject: "agent_script",
      tools: ["read", "artifact"],
      effects: ["read", "write"],
      resources: ["file:**", "artifact-store:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxUses: 20,
    });
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("artifact", artifactTool);
    const sessionId = "ses_codeact_allow", runId = "run_codeact_allow", stepId = "stp_codeact_allow";
    const writer = new EventWriter(store, sessionId);
    writer.append("session.created", {}, { kind: "user", id: "user" });
    writer.append("run.triggered", { runId, trigger: "user" }, { kind: "user", id: "user" });
    writer.append("run.started", { runId }, { kind: "runtime", id: "qi" });
    writer.append("step.started", { runId, stepId }, { kind: "runtime", id: "qi" });
    const client = new ControlledToolClient({
      store,
      registry,
      sessionId,
      runId,
      stepId,
      subject: "agent_script",
      workspaceRoot: root,
      artifactStore: new FileArtifactStore(artifacts),
      allowedTools: ["read"],
    });
    const result = await client.call("artifact", { content: "x", mediaType: "text/plain" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "TOOL_NOT_ALLOWED");
    assert.equal(store.read(sessionId).events.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CodeAct container plan mounts only staged code with network and root filesystem disabled", async () => {
  const invocation = buildContainerInvocation({}, "C:\\isolated-stage");
  assert.deepEqual(invocation.args.slice(0, 6), ["run", "--rm", "--network", "none", "--read-only", "--pids-limit"]);
  const mount = invocation.args[invocation.args.indexOf("--mount") + 1];
  assert.equal(mount, "type=bind,src=C:\\isolated-stage,dst=/program,readonly");
  const root = await mkdtemp(join(tmpdir(), "qi-codeact-container-test-"));
  try {
    const program = join(root, "program.mjs");
    await writeFile(program, "export async function main() { return 1; }\n");
    const sandbox = new ContainerProgramSandbox({ programFile: program, runtime: "qi-runtime-that-does-not-exist" });
    await assert.rejects(sandbox.run({ call: async () => ({ ok: false, code: "NO", message: "no", retryable: false }) }), /Unable to start/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ContainerProgramSandbox requires exactly one of programFile or programSource", async () => {
  const noneProvided = new ContainerProgramSandbox({});
  await assert.rejects(noneProvided.run({ call: async () => ({ ok: false, code: "NO", message: "no", retryable: false }) }), /exactly one of programFile or programSource/);
  const root = await mkdtemp(join(tmpdir(), "qi-codeact-both-"));
  try {
    const program = join(root, "program.mjs");
    await writeFile(program, "export async function main() { return 1; }\n");
    const bothProvided = new ContainerProgramSandbox({ programFile: program, programSource: "export async function main() { return 1; }" });
    await assert.rejects(bothProvided.run({ call: async () => ({ ok: false, code: "NO", message: "no", retryable: false }) }), /exactly one of programFile or programSource/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ContainerProgramSandbox stages inline programSource the same way it stages a programFile", async () => {
  // Using a real "node" binary in place of a container runtime proves staging succeeded (the process actually
  // spawned) without requiring Docker/Podman in the test environment; it fails later for unrelated reasons
  // (node cannot parse "run"/"--rm" as container flags), which both variants must fail with identically.
  const bySource = new ContainerProgramSandbox({
    programSource: "export async function main() { return 1; }\n",
    runtime: "node",
    timeoutMs: 5_000,
  });
  await assert.rejects(
    bySource.run({ call: async () => ({ ok: false, code: "NO", message: "no", retryable: false }) }),
    /Container exited without a result/,
  );
  const root = await mkdtemp(join(tmpdir(), "qi-codeact-source-parity-"));
  try {
    const program = join(root, "program.mjs");
    await writeFile(program, "export async function main() { return 1; }\n");
    const byFile = new ContainerProgramSandbox({ programFile: program, runtime: "node", timeoutMs: 5_000 });
    await assert.rejects(
      byFile.run({ call: async () => ({ ok: false, code: "NO", message: "no", retryable: false }) }),
      /Container exited without a result/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probeContainerRuntime resolves undefined when no candidate runtime responds", async () => {
  const result = await probeContainerRuntime(["qi-fake-runtime-one", "qi-fake-runtime-two"], 500);
  assert.equal(result, undefined);
});

test(
  "probeContainerRuntime resolves the first candidate whose version probe exits 0",
  { skip: process.platform === "win32" && "spawn without shell:true only resolves .exe/.com on Windows, not a scripted stub" },
  async () => {
    const stubName = "qi-fake-runtime-stub";
    const dir = await mkdtemp(join(tmpdir(), "qi-codeact-probe-"));
    const originalPath = process.env.PATH;
    try {
      const script = join(dir, stubName);
      await writeFile(script, "#!/bin/sh\nexit 0\n");
      await chmod(script, 0o755);
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
      const result = await probeContainerRuntime([stubName], 2_000);
      assert.equal(result, stubName);
    } finally {
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
