import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import {
  InMemoryCapabilityBroker,
  InMemoryCredentialBroker,
} from "@civaapple/qi-capability";
import {
  EffectReplayBlockedError,
  ToolRegistry,
  defineTool,
} from "@civaapple/qi-tools";
import {
  ContainerWorkspaceAdapter,
  GitWorktreeAdapter,
  LocalWorkspace,
  SqliteEffectJournal,
  effectIdempotencyKey,
  effectIntentHash,
  hostProcessRunner,
} from "@civaapple/qi-workspace";

test("Effect Journal serializes reservations, replays completion and blocks indeterminate retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-effects-"));
  const path = join(root, "effects.sqlite");
  let journal = new SqliteEffectJournal(path);
  const intentHash = effectIntentHash({ publish: "message", target: "channel:1" });
  const first = journal.begin({ idempotencyKey: "publish:1", intentHash, actionId: "act_one" });
  assert.equal(first.outcome, "acquired");
  assert.equal(journal.begin({ idempotencyKey: "publish:1", intentHash, actionId: "act_two" }).outcome, "blocked");
  journal.markStarted("publish:1");
  journal.complete("publish:1", { remoteId: "message-1" });
  const replay = journal.begin({ idempotencyKey: "publish:1", intentHash, actionId: "act_three" });
  assert.equal(replay.outcome, "replay");
  assert.deepEqual(replay.output, { remoteId: "message-1" });

  journal.begin({ idempotencyKey: "publish:2", intentHash, actionId: "act_four" });
  journal.markStarted("publish:2");
  journal.indeterminate("publish:2", "connection dropped after send");
  journal.close();

  journal = new SqliteEffectJournal(path);
  const blocked = journal.begin({ idempotencyKey: "publish:2", intentHash, actionId: "act_five" });
  assert.equal(blocked.outcome, "blocked");
  assert.match(blocked.reason, /reconciliation/);
  journal.reconcile("publish:2", "failed", "remote lookup confirmed absence");
  const retry = journal.begin({ idempotencyKey: "publish:2", intentHash, actionId: "act_six" });
  assert.equal(retry.outcome, "acquired");
  assert.equal(retry.record.attempts, 2);
  assert.throws(
    () => journal.begin({ idempotencyKey: "publish:2", intentHash: effectIntentHash("different"), actionId: "act_seven" }),
    /different intent/,
  );
  journal.close();
  await rm(root, { recursive: true, force: true });
});

test("Tool Registry uses the Effect Journal to avoid duplicate non-read execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tool-effect-"));
  const journal = new SqliteEffectJournal(join(root, "effects.sqlite"));
  const broker = new InMemoryCapabilityBroker();
  broker.grant({
    leaseId: "lea_effect_test",
    subject: "agent",
    tools: ["publish_once"],
    effects: ["publish"],
    resources: ["remote:item"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  let executions = 0;
  const registry = new ToolRegistry(broker);
  registry.register("publish_once", defineTool({
    description: "Publish one item",
    input: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    output: Type.Object({ remoteId: Type.String() }, { additionalProperties: false }),
    effect: () => "publish",
    resources: () => ["remote:item"],
    async execute() {
      executions += 1;
      return { remoteId: `remote-${executions}` };
    },
  }));
  const artifactStore = { put: async () => { throw new Error("unused"); }, get: async () => { throw new Error("unused"); } };
  const identity = registry.catalog()[0].identity;
  const context = (actionId) => ({
    sessionId: "ses_effect_test",
    runId: "run_effect_test",
    stepId: "stp_effect_test",
    actionId,
    subject: "agent",
    workspaceRoot: root,
    artifactStore,
    effectJournal: journal,
    idempotencyScope: "run_effect_test",
  });
  const first = await registry.execute("publish_once", identity, { value: "same" }, context("act_effect_one"));
  const second = await registry.execute("publish_once", identity, { value: "same" }, context("act_effect_two"));
  assert.equal(executions, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.output, first.output);
  assert.equal(first.idempotencyKey, effectIdempotencyKey("run_effect_test", "publish_once", { value: "same" }, ["remote:item"]));
  journal.close();
  await rm(root, { recursive: true, force: true });
});

test("unknown executor failure becomes an indeterminate journal entry and blocks re-entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-tool-uncertain-"));
  const journal = new SqliteEffectJournal(join(root, "effects.sqlite"));
  const broker = new InMemoryCapabilityBroker();
  broker.grant({
    leaseId: "lea_uncertain_test",
    subject: "agent",
    tools: ["uncertain"],
    effects: ["publish"],
    resources: ["remote:item"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  let executions = 0;
  const registry = new ToolRegistry(broker);
  registry.register("uncertain", defineTool({
    description: "Uncertain publish",
    input: Type.Object({ value: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
    effect: () => "publish",
    resources: () => ["remote:item"],
    async execute() {
      executions += 1;
      throw new Error("connection lost after request body");
    },
  }));
  const artifactStore = { put: async () => { throw new Error("unused"); }, get: async () => { throw new Error("unused"); } };
  const identity = registry.catalog()[0].identity;
  const context = (actionId) => ({
    sessionId: "ses_uncertain_test",
    runId: "run_uncertain_test",
    stepId: "stp_uncertain_test",
    actionId,
    subject: "agent",
    workspaceRoot: root,
    artifactStore,
    effectJournal: journal,
  });
  await assert.rejects(registry.execute("uncertain", identity, { value: "same" }, context("act_uncertain_one")), /connection lost/);
  await assert.rejects(
    registry.execute("uncertain", identity, { value: "same" }, context("act_uncertain_two")),
    (error) => error instanceof EffectReplayBlockedError,
  );
  assert.equal(executions, 1);
  journal.close();
  await rm(root, { recursive: true, force: true });
});

test("delegated leases can only narrow parent scope and expose a policy trace", async () => {
  const broker = new InMemoryCapabilityBroker();
  broker.grant({
    leaseId: "lea_parent_scope",
    subject: "parent",
    tools: ["read", "write"],
    effects: ["read", "write"],
    resources: ["file:src/**"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    maxUses: 5,
  });
  const child = broker.delegate("lea_parent_scope", {
    leaseId: "lea_child_scope",
    subject: "child",
    tools: ["read"],
    effects: ["read"],
    resources: ["file:src/a.ts"],
    expiresAt: "2098-01-01T00:00:00.000Z",
    maxUses: 2,
  });
  assert.equal(child.delegatedFrom, "lea_parent_scope");
  const granted = await broker.authorize({ actionId: "act_child_read", subject: "child", tool: "read", effect: "read", resources: ["file:src/a.ts"] });
  assert.equal(granted.outcome, "granted");
  assert.ok(granted.trace.some((entry) => entry.leaseId === "lea_child_scope" && entry.matched));
  const denied = await broker.authorize({ actionId: "act_child_write", subject: "child", tool: "write", effect: "write", resources: ["file:src/a.ts"] });
  assert.equal(denied.outcome, "denied");
  assert.ok(denied.trace.some((entry) => entry.reason.includes("effect") || entry.reason.includes("subject")));
  assert.throws(() => broker.delegate("lea_parent_scope", {
    leaseId: "lea_child_escape",
    subject: "child",
    tools: ["read"],
    effects: ["read"],
    resources: ["file:secrets/**"],
    expiresAt: "2098-01-01T00:00:00.000Z",
    maxUses: 1,
  }), /resources exceed/);
});

test("Credential Broker keeps secrets behind subject- and intent-bound handles", () => {
  const broker = new InMemoryCredentialBroker();
  broker.register("deploy-token", "super-secret", {
    tools: ["publish"],
    resources: ["remote:staging"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const handle = broker.issue("deploy-token", "agent");
  assert.doesNotMatch(JSON.stringify(handle), /super-secret/);
  const intent = { actionId: "act_publish", subject: "agent", tool: "publish", effect: "publish", resources: ["remote:staging"] };
  assert.equal(broker.resolve(handle.handle, intent), "super-secret");
  assert.throws(() => broker.resolve(handle.handle, { ...intent, subject: "other" }), /another subject/);
  broker.revokeCredential("deploy-token");
  assert.throws(() => broker.resolve(handle.handle, intent), /unknown or revoked/);
});

test("Local Workspace observations detect stale files and reject path escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-observe-"));
  await writeFile(join(root, "file.txt"), "one");
  const workspace = new LocalWorkspace(root);
  const observation = await workspace.observe("file.txt");
  await workspace.assertFresh(observation);
  await writeFile(join(root, "file.txt"), "two");
  await assert.rejects(workspace.assertFresh(observation), /Stale observation/);
  assert.throws(() => workspace.resolvePath("../outside"), /outside Workspace/);
  await rm(root, { recursive: true, force: true });
});

test("Container adapter builds a network-off, read-only-root plan and fails honestly when unavailable", async () => {
  const calls = [];
  const runner = {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return { exitCode: 1, stdout: "", stderr: "daemon unavailable" };
    },
  };
  const adapter = new ContainerWorkspaceAdapter("docker", runner);
  const plan = adapter.plan({ image: "node:24", workspaceRoot: ".", command: "node", args: ["--version"] });
  assert.equal(plan.command, "docker");
  assert.deepEqual(plan.args.slice(0, 6), ["run", "--rm", "--network", "none", "--read-only", "--mount"]);
  assert.match(plan.args[6], /readonly$/);
  await assert.rejects(adapter.run({ image: "node:24", workspaceRoot: ".", command: "node", args: [] }), /no sandbox was started/);
  assert.deepEqual(calls[0], { command: "docker", args: ["version", "--format", "{{.Server.Version}}"] });
});

test("Git Worktree adapter creates an isolated branch and exposes its diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-worktree-"));
  const repository = join(root, "repository");
  const branchRoot = join(root, "branch");
  await mkdir(repository);
  for (const args of [
    ["init"],
    ["config", "user.email", "qi@example.invalid"],
    ["config", "user.name", "Qi Test"],
  ]) {
    const result = await hostProcessRunner.run("git", args, { cwd: repository });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  await writeFile(join(repository, "README.md"), "base\n");
  assert.equal((await hostProcessRunner.run("git", ["add", "README.md"], { cwd: repository })).exitCode, 0);
  assert.equal((await hostProcessRunner.run("git", ["commit", "-m", "base"], { cwd: repository })).exitCode, 0);
  const adapter = new GitWorktreeAdapter(repository);
  await adapter.assertAvailable();
  const branch = await adapter.branch("qi/test-branch", branchRoot);
  assert.equal(branch.root, branchRoot);
  await writeFile(join(branchRoot, "README.md"), "changed\n");
  const diff = await adapter.diff(branchRoot);
  assert.match(diff, /-base/);
  assert.match(diff, /\+changed/);
  assert.equal(await readFile(join(repository, "README.md"), "utf8"), "base\n");
  await rm(root, { recursive: true, force: true });
});
