import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { ToolFailure, ToolRegistry } from "@civaapple/qi-agent/tools";
import {
  applyEditsToFileContent,
  prepareEditInput,
} from "../packages/node/dist/tools/edit-apply.js";
import { editTool, FileArtifactStore, readTool } from "@civaapple/qi-node/tools";

function sha(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function identity(registry, name) {
  const tool = registry.catalog().find((entry) => entry.name === name);
  assert.ok(tool, `Expected ${name} in tool catalog`);
  return tool.identity;
}

test("prepareEditInput normalizes legacy oldText/newText into edits[]", () => {
  assert.deepEqual(
    prepareEditInput({
      path: "a.ts",
      expectedSha256: "a".repeat(64),
      oldText: "foo",
      newText: "bar",
      replaceAll: true,
    }),
    {
      path: "a.ts",
      expectedSha256: "a".repeat(64),
      edits: [{ oldText: "foo", newText: "bar", replaceAll: true }],
    },
  );
  assert.deepEqual(
    prepareEditInput({
      path: "a.ts",
      expectedSha256: "a".repeat(64),
      edits: [{ oldText: "foo", newText: "bar" }],
    }),
    {
      path: "a.ts",
      expectedSha256: "a".repeat(64),
      edits: [{ oldText: "foo", newText: "bar" }],
    },
  );
});

test("applyEditsToFileContent matches all hunks against the original snapshot", () => {
  const applied = applyEditsToFileContent("alpha\nomega\ntail\n", [
    { oldText: "alpha", newText: "beta" },
    { oldText: "omega", newText: "sigma" },
    { oldText: "tail", newText: "end" },
  ]);
  assert.equal(applied.content, "beta\nsigma\nend\n");
  assert.equal(applied.replacements, 3);
  assert.equal(applied.usedFuzzyMatch, false);
});

test("applyEditsToFileContent rejects overlapping hunks", () => {
  assert.throws(
    () => applyEditsToFileContent("abcdef", [
      { oldText: "abc", newText: "XYZ" },
      { oldText: "cde", newText: "123" },
    ]),
    (error) => error instanceof ToolFailure && error.code === "EDIT_TARGETS_OVERLAP",
  );
});

test("applyEditsToFileContent uses limited fuzzy trailing-whitespace matching", () => {
  // Exact match fails because oldText has no trailing spaces before the newline.
  const applied = applyEditsToFileContent("const x = 1;   \nkeep\n", [
    { oldText: "const x = 1;\nkeep", newText: "const x = 2;\nkeep" },
  ]);
  assert.equal(applied.content, "const x = 2;\nkeep\n");
  assert.equal(applied.usedFuzzyMatch, true);
});

test("applyEditsToFileContent preserves BOM and CRLF while accepting LF model fragments", () => {
  const original = "\uFEFFline 1\r\nline 2\r\nline 3\r\n";
  const applied = applyEditsToFileContent(original, [
    { oldText: "line 2\nline 3", newText: "line two\nline three" },
  ]);
  assert.equal(applied.content, "\uFEFFline 1\r\nline two\r\nline three\r\n");
});

test("edit tool applies multi-hunk edits atomically with freshness", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-edit-multi-"));
  try {
    await writeFile(join(root, "app.ts"), "one\ntwo\nthree\n", "utf8");
    const artifacts = join(root, ".artifacts");
    await mkdir(artifacts, { recursive: true });
    const artifactStore = new FileArtifactStore(artifacts);
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_edit_multi",
      subject: "agent_main",
      tools: ["read", "edit"],
      effects: ["read", "write"],
      resources: ["file:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("edit", editTool);
    const context = {
      sessionId: "ses_edit",
      runId: "run_edit",
      stepId: "stp_edit",
      actionId: "act_edit",
      subject: "agent_main",
      workspaceRoot: root,
      artifactStore,
    };
    const observed = await registry.execute(
      "read",
      identity(registry, "read"),
      { path: "app.ts" },
      { ...context, actionId: "act_read" },
    );
    const edited = await registry.execute(
      "edit",
      identity(registry, "edit"),
      {
        path: "app.ts",
        expectedSha256: observed.output.sha256,
        edits: [
          { oldText: "one", newText: "alpha" },
          { oldText: "three", newText: "gamma" },
        ],
      },
      context,
    );
    assert.equal(edited.output.replacements, 2);
    assert.equal(await readFile(join(root, "app.ts"), "utf8"), "alpha\ntwo\ngamma\n");
    assert.equal(edited.output.sha256, sha("alpha\ntwo\ngamma\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit tool still accepts legacy top-level oldText/newText", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-edit-legacy-"));
  try {
    await writeFile(join(root, "a.ts"), "hello\n", "utf8");
    const artifacts = join(root, ".artifacts");
    await mkdir(artifacts, { recursive: true });
    const artifactStore = new FileArtifactStore(artifacts);
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_edit_legacy",
      subject: "agent_main",
      tools: ["edit"],
      effects: ["write"],
      resources: ["file:**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const registry = new ToolRegistry(broker);
    registry.register("edit", editTool);
    const edited = await registry.execute(
      "edit",
      identity(registry, "edit"),
      {
        path: "a.ts",
        oldText: "hello",
        newText: "world",
        expectedSha256: sha("hello\n"),
      },
      {
        sessionId: "ses_edit",
        runId: "run_edit",
        stepId: "stp_edit",
        actionId: "act_edit",
        subject: "agent_main",
        workspaceRoot: root,
        artifactStore,
      },
    );
    assert.equal(edited.output.replacements, 1);
    assert.equal(await readFile(join(root, "a.ts"), "utf8"), "world\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
