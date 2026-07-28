import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASK_MODE_TOOLS, InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import {
  createQiIntrospectionTool,
  createQiSessionInspectionTool,
  createQiSelfContext,
  inspectQiSession,
  qiSelfModel,
  parseQiSelfModel,
  queryQiSelfModel,
} from "@civaapple/qi-agent/extensions";
import { SkillLoader } from "@civaapple/qi-node/skills";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TurnLoop } from "@civaapple/qi-agent/loop";
import { FileArtifactStore, ToolRegistry, readTool } from "@civaapple/qi-node/tools";
import { parse } from "yaml";

const root = process.cwd();

async function workspacePackages() {
  const paths = [];
  for (const parent of ["packages", "apps"]) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, parent, entry.name, "package.json");
      try {
        const manifest = JSON.parse(await readFile(path, "utf8"));
        paths.push({
          name: manifest.name,
          path: `${parent}/${entry.name}`,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return paths.sort((left, right) => left.name.localeCompare(right.name));
}

test("QiSelfModel validates and covers every workspace package and README", async () => {
  const parsed = parseQiSelfModel(qiSelfModel);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(
    parsed.packages.map(({ name, path }) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name)),
    await workspacePackages(),
  );
  for (const pkg of parsed.packages) {
    const readme = await readFile(join(root, pkg.canonicalReadme), "utf8");
    assert.match(readme, /^# /);
  }
  for (const pkg of parsed.packages) {
    assert.equal(
      pkg.packageMaturity,
      pkg.path.startsWith("packages/") ? "packable-preview" : "internal",
      `${pkg.name} package maturity must match its workspace role`,
    );
  }
});

test("QiSelfModel decisions point to unique sections in the consolidated decision record", async () => {
  const record = await readFile(join(root, "design", "decisions.md"), "utf8");
  const anchors = new Set(
    record.split(/\r?\n/u)
      .filter((line) => /^## ADR-\d{4}: /u.test(line))
      .map((line) => line.slice(3).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/gu, "-")),
  );
  const sources = qiSelfModel.decisions.map((decision) => decision.source);
  assert.equal(new Set(sources).size, sources.length);
  for (const decision of qiSelfModel.decisions) {
    assert.equal(decision.status, "accepted");
    const [, anchor] = decision.source.split("#");
    assert.ok(anchor, `${decision.id} must name a decision anchor`);
    assert.ok(anchors.has(anchor), `${decision.id} must reference an existing decision heading`);
  }
  assert.equal(qiSelfModel.decisions.some(({ id }) => id === "ADR-0007"), false);
  assert.equal(qiSelfModel.decisions.some(({ id }) => id === "ADR-0019"), true);
});

test("self queries and Context are bounded, provenance-bearing, and authority-neutral", () => {
  const packages = queryQiSelfModel("packages");
  assert.ok(Array.isArray(packages));
  const context = createQiSelfContext(["identity", "invariants", "gaps"]);
  assert.equal(context.source, "@civaapple/qi-agent/extensions");
  assert.equal(context.required, false);
  assert.match(context.content, /not authority/i);
  assert.ok(context.content.length < 64_000);
  assert.ok(ASK_MODE_TOOLS.includes("qi_introspect"));
  assert.equal(
    qiSelfModel.verification.find(({ id }) => id === "source-release")?.command,
    "npm run release:audit",
  );
  assert.equal(
    qiSelfModel.gaps.find(({ id }) => id === "source-archive-blocked")?.humanOwned,
    true,
  );
});

test("qi_introspect remains default-deny and executes only with an explicit read lease", async () => {
  const broker = new InMemoryCapabilityBroker();
  const registry = new ToolRegistry(broker);
  const registration = registry.register("qi_introspect", createQiIntrospectionTool());
  const context = {
    sessionId: "ses_introspection",
    runId: "run_introspection",
    stepId: "stp_introspection",
    actionId: "act_introspection",
    subject: "main-agent",
    workspaceRoot: root,
    artifactStore: {
      async put() {
        throw new Error("not used");
      },
      async get() {
        throw new Error("not used");
      },
    },
  };

  await assert.rejects(
    registry.execute(
      "qi_introspect",
      registration.identity,
      { section: "identity" },
      context,
    ),
    /No active lease permits read/u,
  );

  broker.grant({
    leaseId: "lea_self_read",
    subject: "main-agent",
    tools: ["qi_introspect"],
    effects: ["read"],
    resources: ["qi:self-model:**"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const settlement = await registry.execute(
    "qi_introspect",
    registration.identity,
    { section: "identity" },
    { ...context, actionId: "act_introspection_granted" },
  );
  assert.equal(settlement.output.release, "0.6.0");
  assert.match(settlement.output.authorityNotice, /cannot grant capabilities/u);
});

test("Session inspection returns bounded Run/Step projections and the model Tool stays read-only", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "qi-session-inspect-"));
  try {
    const artifacts = join(temporary, "artifacts");
    await mkdir(artifacts);
    const store = new InMemoryEventStore();
    const loop = new TurnLoop({
      eventStore: store,
      modelPort: new ScriptedModelPort([[
        { type: "text.delta", delta: "A".repeat(900) },
        { type: "completed", finishReason: "stop" },
      ]]),
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    });
    const result = await loop.run({
      sessionId: "ses_inspect_trace",
      title: "Inspection trace",
      subject: "main-agent",
      input: "Inspect this",
      model: { provider: "fake", model: "inspect-v1" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 2,
      workspaceRoot: temporary,
      artifactStore: new FileArtifactStore(artifacts),
    });

    const runs = inspectQiSession(store, {
      operation: "runs",
      sessionId: result.sessionId,
      limit: 1,
    });
    assert.equal(runs.items[0].runId, result.runId);
    assert.equal(runs.items[0].status, "completed");
    assert.equal(runs.truncated, false);

    const lastStep = inspectQiSession(store, {
      operation: "last-step",
      sessionId: result.sessionId,
      runId: "last",
    });
    assert.equal(lastStep.items[0].kind, "step");
    assert.equal(lastStep.items[0].modelText.length, 501);
    assert.equal(lastStep.truncated, true);
    assert.ok(lastStep.omissions.textCharacters > 0);
    assert.throws(
      () => inspectQiSession(store, {
        operation: "step",
        sessionId: result.sessionId,
        stepId: "stp_missing",
      }),
      /Step stp_missing was not found/,
    );

    const actionRegistry = new ToolRegistry(new InMemoryCapabilityBroker());
    actionRegistry.register("read", readTool);
    const problemRun = await new TurnLoop({
      eventStore: store,
      modelPort: new ScriptedModelPort([
        [
          { type: "action.requested", callId: "call_denied_read", name: "read", input: { path: "README.md" } },
          { type: "completed", finishReason: "actions" },
        ],
        [
          { type: "text.delta", delta: "Read authority was denied." },
          { type: "completed", finishReason: "stop" },
        ],
      ]),
      toolRegistry: actionRegistry,
    }).run({
      sessionId: result.sessionId,
      subject: "main-agent",
      input: "Read without a lease",
      model: { provider: "fake", model: "inspect-v1" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 3,
      workspaceRoot: temporary,
      artifactStore: new FileArtifactStore(artifacts),
    });
    const problems = inspectQiSession(store, {
      operation: "problems",
      sessionId: result.sessionId,
      runId: problemRun.runId,
      detail: "detail",
    });
    const denied = problems.items.find((item) => item.kind === "action");
    assert.equal(denied.status, "denied");
    assert.equal(denied.errorCode, "AUTHORITY_DENIED");
    assert.ok(Number.isInteger(denied.sequenceStart));
    assert.ok(Number.isInteger(denied.sequenceEnd));

    assert.ok(ASK_MODE_TOOLS.includes("qi_session_inspect"));
    const broker = new InMemoryCapabilityBroker();
    const registry = new ToolRegistry(broker);
    const registration = registry.register(
      "qi_session_inspect",
      createQiSessionInspectionTool(store, result.sessionId),
    );
    const context = {
      sessionId: result.sessionId,
      runId: "run_inspection_tool",
      stepId: "stp_inspection_tool",
      actionId: "act_inspection_tool",
      subject: "main-agent",
      workspaceRoot: temporary,
      artifactStore: new FileArtifactStore(artifacts),
    };
    await assert.rejects(
      registry.execute("qi_session_inspect", registration.identity, { operation: "runs" }, context),
      /No active lease permits read/,
    );
    broker.grant({
      leaseId: "lea_session_read",
      subject: "main-agent",
      tools: ["qi_session_inspect"],
      effects: ["read"],
      resources: ["qi:session:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const settlement = await registry.execute(
      "qi_session_inspect",
      registration.identity,
      { operation: "runs" },
      { ...context, actionId: "act_inspection_tool_granted" },
    );
    assert.equal(settlement.output.items[0].runId, problemRun.runId);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the governed self-improvement Skill is loadable and has valid interface metadata", async () => {
  const skillRoot = join(root, ".qi", "skills", "improve-qi");
  const loaded = await new SkillLoader().load(skillRoot);
  assert.equal(loaded.name, "improve-qi");
  assert.match(loaded.instructions, /Do not choose an open-source license/u);
  assert.match(loaded.instructions, /Do not publish source, packages, or releases/u);

  const interfaceDocument = parse(
    await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8"),
  );
  assert.equal(interfaceDocument.interface.display_name, "Improve Qi");
  assert.match(interfaceDocument.interface.default_prompt, /\$improve-qi/u);
});
