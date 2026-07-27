import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-capability";
import {
  AuthorityDeniedError,
  FileArtifactStore,
  StaleToolError,
  ToolFailure,
  ToolInputError,
  ToolRegistry,
  artifactTool,
  createVerifyTool,
  editTool,
  findTool,
  gitTool,
  listTool,
  loadVerificationProfiles,
  moveTool,
  prepareVerificationProfiles,
  readTool,
  removeTool,
  searchTool,
  shellTool,
  treeTool,
  writeTool,
} from "@civaapple/qi-tools";

const execFileAsync = promisify(execFile);

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "qi-tools-test-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts, { recursive: true });
  try {
    await run({ root, artifactStore: new FileArtifactStore(artifacts) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(root, artifactStore, actionId = "act_tools_001") {
  return {
    sessionId: "ses_tools_001",
    runId: "run_tools_001",
    stepId: "stp_tools_001",
    actionId,
    subject: "agent_main",
    workspaceRoot: root,
    artifactStore,
  };
}

function grant(broker, overrides = {}) {
  broker.grant({
    leaseId: "lea_tools_test",
    subject: "agent_main",
    tools: ["*"],
    effects: ["read", "write", "execute"],
    resources: ["file:**", "tree:**", "vcs:**", "host-process:**", "host-workspace:**", "shell-profile:**", "artifact-store:**", "verification:**"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function identity(registry, name) {
  const tool = registry.catalog().find((entry) => entry.name === name);
  assert.ok(tool, `Expected ${name} in tool catalog`);
  return tool.identity;
}

test("Capability Broker denies by default and Registry never enters the executor", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "secret.txt"), "private");
    const registry = new ToolRegistry(new InMemoryCapabilityBroker());
    registry.register("read", readTool);

    await assert.rejects(
      registry.execute("read", identity(registry, "read"), { path: "secret.txt" }, context(root, artifactStore)),
      (error) => error instanceof AuthorityDeniedError,
    );
  });
});

test("Registry rejects calls when the advertised tool identity was replaced", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "note.txt"), "hello");
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    const original = registry.register("read", readTool);
    const replacement = registry.register("read", readTool);

    await assert.rejects(
      registry.execute("read", original.identity, { path: "note.txt" }, context(root, artifactStore)),
      (error) => error instanceof StaleToolError,
    );

    replacement.close();
    const settlement = await registry.execute(
      "read",
      original.identity,
      { path: "note.txt" },
      context(root, artifactStore),
    );
    assert.equal(settlement.output.content, "hello");
  });
});

test("read and write enforce fresh observations and Workspace boundaries", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "document.txt"), "version one");
    if (process.platform !== "win32") await chmod(join(root, "document.txt"), 0o751);
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("write", writeTool);
    registry.register("edit", editTool);

    await mkdir(join(root, ".qi"));
    await writeFile(join(root, ".qi", "private.txt"), "runtime state");
    await assert.rejects(
      registry.execute(
        "read",
        identity(registry, "read"),
        { path: ".qi/private.txt" },
        context(root, artifactStore, "act_read_private_state"),
      ),
      (error) => error instanceof ToolFailure && error.code === "PROTECTED_WORKSPACE_PATH",
    );
    await assert.rejects(
      registry.execute(
        "write",
        identity(registry, "write"),
        { path: ".qi/injected.json", content: "{}", expectedSha256: null },
        context(root, artifactStore, "act_write_private_state"),
      ),
      (error) => error instanceof ToolFailure && error.code === "PROTECTED_WORKSPACE_PATH",
    );

    const read = await registry.execute(
      "read",
      identity(registry, "read"),
      { path: "document.txt" },
      context(root, artifactStore, "act_read_001"),
    );
    const written = await registry.execute(
      "write",
      identity(registry, "write"),
      { path: "document.txt", content: "version two", expectedSha256: read.output.sha256 },
      context(root, artifactStore, "act_write_001"),
    );
    assert.equal(written.output.created, false);
    assert.equal(written.output.previousSha256, read.output.sha256);
    assert.match(written.output.diff, /^-version one$/m);
    assert.match(written.output.diff, /^\+version two$/m);
    assert.equal(written.output.diffTruncated, false);
    assert.equal(await readFile(join(root, "document.txt"), "utf8"), "version two");
    if (process.platform !== "win32") assert.equal((await stat(join(root, "document.txt"))).mode & 0o777, 0o751);

    const edited = await registry.execute(
      "edit",
      identity(registry, "edit"),
      {
        path: "document.txt",
        oldText: "version two",
        newText: "version three",
        expectedSha256: written.output.sha256,
      },
      context(root, artifactStore, "act_edit_001"),
    );
    assert.equal(edited.output.previousSha256, written.output.sha256);
    assert.equal(edited.output.replacements, 1);
    assert.match(edited.output.diff, /^-version two$/m);
    assert.match(edited.output.diff, /^\+version three$/m);
    assert.equal(await readFile(join(root, "document.txt"), "utf8"), "version three");
    if (process.platform !== "win32") assert.equal((await stat(join(root, "document.txt"))).mode & 0o777, 0o751);

    const literalReplacement = await registry.execute(
      "edit",
      identity(registry, "edit"),
      {
        path: "document.txt",
        oldText: "version three",
        newText: "`$${value}`",
        expectedSha256: edited.output.sha256,
      },
      context(root, artifactStore, "act_edit_literal_replacement"),
    );
    assert.equal(literalReplacement.output.replacements, 1);
    assert.equal(await readFile(join(root, "document.txt"), "utf8"), "`$${value}`");

    await mkdir(join(root, "not-a-file"));
    await assert.rejects(
      registry.execute(
        "write",
        identity(registry, "write"),
        { path: "not-a-file", content: "must not replace a directory", expectedSha256: null },
        context(root, artifactStore, "act_write_directory"),
      ),
      (error) => error instanceof ToolFailure && error.code === "NOT_A_FILE",
    );
    if (process.platform !== "win32") {
      await symlink("document.txt", join(root, "document-link.txt"));
      await assert.rejects(
        registry.execute(
          "edit",
          identity(registry, "edit"),
          {
            path: "document-link.txt",
            oldText: "value",
            newText: "changed",
            expectedSha256: literalReplacement.output.sha256,
          },
          context(root, artifactStore, "act_edit_symlink"),
        ),
        (error) => error instanceof ToolFailure && error.code === "SYMLINK_NOT_ALLOWED",
      );
    }

    await assert.rejects(
      registry.execute(
        "write",
        identity(registry, "write"),
        { path: "document.txt", content: "stale overwrite", expectedSha256: read.output.sha256 },
        context(root, artifactStore, "act_write_002"),
      ),
      (error) => error instanceof ToolFailure && error.code === "STALE_READ",
    );
    await assert.rejects(
      registry.execute(
        "edit",
        identity(registry, "edit"),
        {
          path: "document.txt",
          oldText: "version three",
          newText: "stale edit",
          expectedSha256: written.output.sha256,
        },
        context(root, artifactStore, "act_edit_002"),
      ),
      (error) => error instanceof ToolFailure && error.code === "STALE_READ",
    );
    await writeFile(join(root, "ambiguous.txt"), "same same");
    const ambiguousRead = await registry.execute(
      "read",
      identity(registry, "read"),
      { path: "ambiguous.txt" },
      context(root, artifactStore, "act_read_ambiguous"),
    );
    await assert.rejects(
      registry.execute(
        "edit",
        identity(registry, "edit"),
        {
          path: "ambiguous.txt",
          oldText: "same",
          newText: "changed",
          expectedSha256: ambiguousRead.output.sha256,
        },
        context(root, artifactStore, "act_edit_ambiguous"),
      ),
      (error) => error instanceof ToolFailure && error.code === "EDIT_TARGET_AMBIGUOUS",
    );
    await assert.rejects(
      registry.execute(
        "read",
        identity(registry, "read"),
        { path: "../outside.txt" },
        context(root, artifactStore, "act_read_002"),
      ),
      (error) => error instanceof ToolFailure && error.code === "PATH_GRANT_REQUIRED",
    );
  });
});

test("edit reconciles model line endings while preserving BOM, file convention, and contextual diffs", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    const originalLines = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`);
    const original = `\uFEFF${originalLines.join("\r\n")}\r\n`;
    await writeFile(join(root, "windows.txt"), original, "utf8");

    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("edit", editTool);
    registry.register("write", writeTool);

    const observed = await registry.execute(
      "read",
      identity(registry, "read"),
      { path: "windows.txt" },
      context(root, artifactStore, "act_read_crlf"),
    );
    const edited = await registry.execute(
      "edit",
      identity(registry, "edit"),
      {
        path: "windows.txt",
        oldText: "line 8\nline 9",
        newText: "line eight\nline nine",
        expectedSha256: observed.output.sha256,
      },
      context(root, artifactStore, "act_edit_crlf"),
    );

    const editedContent = await readFile(join(root, "windows.txt"), "utf8");
    assert.ok(editedContent.startsWith("\uFEFFline 1\r\n"));
    assert.match(editedContent, /line eight\r\nline nine\r\n/);
    assert.equal(editedContent.replaceAll("\r\n", "").includes("\n"), false);
    assert.match(edited.output.diff, /-line 8/);
    assert.match(edited.output.diff, /\+line eight/);
    assert.doesNotMatch(edited.output.diff, /line 1\r?$/m);

    const replacement = editedContent.replace("line 13", "line thirteen");
    const written = await registry.execute(
      "write",
      identity(registry, "write"),
      { path: "windows.txt", content: replacement, expectedSha256: edited.output.sha256 },
      context(root, artifactStore, "act_write_contextual_diff"),
    );
    assert.match(written.output.diff, /-line 13/);
    assert.match(written.output.diff, /\+line thirteen/);
    assert.doesNotMatch(written.output.diff, /line 1\r?$/m);
  });
});

test("move and remove enforce freshness, reject overwrite and preserve a recoverable backup", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "source.txt"), "recoverable content\n");
    await writeFile(join(root, "occupied.txt"), "do not overwrite\n");
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    registry.register("move", moveTool);
    registry.register("remove", removeTool);
    const observed = await registry.execute(
      "read",
      identity(registry, "read"),
      { path: "source.txt" },
      context(root, artifactStore, "act_lifecycle_read"),
    );

    await assert.rejects(
      registry.execute(
        "move",
        identity(registry, "move"),
        { from: "source.txt", to: "occupied.txt", expectedSha256: observed.output.sha256 },
        context(root, artifactStore, "act_move_occupied"),
      ),
      (error) => error instanceof ToolFailure && error.code === "TARGET_EXISTS",
    );
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "recoverable content\n");

    const moved = await registry.execute(
      "move",
      identity(registry, "move"),
      { from: "source.txt", to: "nested/renamed.txt", expectedSha256: observed.output.sha256 },
      context(root, artifactStore, "act_move_valid"),
    );
    assert.equal(moved.output.sha256, observed.output.sha256);
    assert.equal(await readFile(join(root, "nested", "renamed.txt"), "utf8"), "recoverable content\n");
    await assert.rejects(readFile(join(root, "source.txt"), "utf8"), { code: "ENOENT" });

    await writeFile(join(root, "nested", "renamed.txt"), "changed after observation\n");
    await assert.rejects(
      registry.execute(
        "remove",
        identity(registry, "remove"),
        { path: "nested/renamed.txt", expectedSha256: observed.output.sha256 },
        context(root, artifactStore, "act_remove_stale"),
      ),
      (error) => error instanceof ToolFailure && error.code === "STALE_READ",
    );
    const refreshed = await registry.execute(
      "read",
      identity(registry, "read"),
      { path: "nested/renamed.txt" },
      context(root, artifactStore, "act_lifecycle_refresh"),
    );
    const removed = await registry.execute(
      "remove",
      identity(registry, "remove"),
      { path: "nested/renamed.txt", expectedSha256: refreshed.output.sha256 },
      context(root, artifactStore, "act_remove_valid"),
    );
    assert.equal(removed.output.previousSha256, refreshed.output.sha256);
    assert.match(removed.output.backupRef, /^artifact:\/\//);
    const backup = await artifactStore.get(removed.output.backupRef);
    assert.equal(Buffer.from(backup.content).toString("utf8"), "changed after observation\n");
    await assert.rejects(readFile(join(root, "nested", "renamed.txt"), "utf8"), { code: "ENOENT" });
  });
});

test("search is bounded, deterministic and ignores generated dependency trees", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(root, "src", "a.txt"), "needle first\nnone");
    await writeFile(join(root, "src", "b.txt"), "needle second");
    await writeFile(join(root, "node_modules", "ignored", "c.txt"), "needle hidden");
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("search", searchTool);

    const settlement = await registry.execute(
      "search",
      identity(registry, "search"),
      { query: "needle", path: ".", maxResults: 1 },
      context(root, artifactStore),
    );
    assert.equal(settlement.output.matches.length, 1);
    assert.equal(settlement.output.matches[0].path, "src/a.txt");
    assert.equal(settlement.output.truncated, true);
    assert.match(settlement.output.engine, /^(rg|node)$/);

    const regex = await registry.execute(
      "search",
      identity(registry, "search"),
      { query: "needle (first|second)", path: "src", mode: "regex", maxResults: 10 },
      context(root, artifactStore, "act_search_regex"),
    );
    assert.deepEqual(regex.output.matches.map((match) => match.path), ["src/a.txt", "src/b.txt"]);
  });
});

test("list provides bounded deterministic file discovery without reading contents", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(root, "README.md"), "secret content");
    await writeFile(join(root, "src", "index.ts"), "export {};");
    await writeFile(join(root, "src", "nested", "deep.ts"), "export const deep = true;");
    await writeFile(join(root, "node_modules", "ignored", "package.json"), "{}");
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("list", listTool);

    const shallow = await registry.execute(
      "list",
      identity(registry, "list"),
      { path: "." },
      context(root, artifactStore, "act_list_001"),
    );
    assert.deepEqual(shallow.output.entries, [
      { path: "README.md", type: "file" },
      { path: "src", type: "directory" },
    ]);
    assert.equal(JSON.stringify(shallow.output).includes("secret content"), false);

    const recursive = await registry.execute(
      "list",
      identity(registry, "list"),
      { path: ".", recursive: true, maxEntries: 3 },
      context(root, artifactStore, "act_list_002"),
    );
    assert.deepEqual(recursive.output.entries, [
      { path: "README.md", type: "file" },
      { path: "src", type: "directory" },
      { path: "src/index.ts", type: "file" },
    ]);
    assert.equal(recursive.output.truncated, true);
  });
});

test("recursive search requires tree authority rather than inheriting one-file read authority", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "visible.txt"), "needle");
    const broker = new InMemoryCapabilityBroker();
    grant(broker, { resources: ["file:**"] });
    const registry = new ToolRegistry(broker);
    registry.register("search", searchTool);

    await assert.rejects(
      registry.execute(
        "search",
        identity(registry, "search"),
        { query: "needle", path: "." },
        context(root, artifactStore),
      ),
      (error) => error instanceof AuthorityDeniedError,
    );
  });
});

test("find locates entries by name, type, time and depth while tree stays bounded", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await writeFile(join(root, "src", "nested", "deep.ts"), "export const deep = true;\n");
    await writeFile(join(root, "src", "old.md"), "old\n");
    await writeFile(join(root, "node_modules", "ignored", "hidden.ts"), "ignored\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, "src", "old.md"), old, old);
    const cutoff = new Date(Date.now() - 10_000).toISOString();
    const broker = new InMemoryCapabilityBroker();
    grant(broker, { tools: ["find", "tree"], effects: ["read"], resources: ["tree:**"] });
    const registry = new ToolRegistry(broker);
    registry.register("find", findTool);
    registry.register("tree", treeTool);

    const found = await registry.execute(
      "find",
      identity(registry, "find"),
      {
        pattern: "\\.ts$",
        mode: "regex",
        path: "src",
        type: "file",
        modifiedAfter: cutoff,
        maxDepth: 3,
        maxResults: 10,
      },
      context(root, artifactStore, "act_find_001"),
    );
    assert.deepEqual(found.output.entries.map((entry) => entry.path), ["src/index.ts", "src/nested/deep.ts"]);
    assert.ok(found.output.entries.every((entry) => entry.type === "file" && entry.modifiedAt >= cutoff));
    assert.match(found.output.engine, /^(fd|node)$/);

    const globbed = await registry.execute(
      "find",
      identity(registry, "find"),
      {
        pattern: "**/*.{ts,md}",
        path: "src",
        type: "file",
        maxResults: 20,
      },
      context(root, artifactStore, "act_find_glob"),
    );
    assert.deepEqual(
      globbed.output.entries.map((entry) => entry.path).sort(),
      ["src/index.ts", "src/nested/deep.ts", "src/old.md"],
    );

    const tree = await registry.execute(
      "tree",
      identity(registry, "tree"),
      { path: ".", maxDepth: 2, maxEntries: 20 },
      context(root, artifactStore, "act_tree_001"),
    );
    assert.match(tree.output.tree, /^\.\n/);
    assert.match(tree.output.tree, /src\//);
    assert.match(tree.output.tree, /index\.ts/);
    assert.doesNotMatch(tree.output.tree, /node_modules|hidden\.ts|deep\.ts/);
    assert.ok(tree.output.entryCount <= 20);
  });
});

test("git inspection exposes fixed read-only status and diff operations", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "note.txt"), "before\n");
    await execFileAsync("git", ["add", "note.txt"], { cwd: root });
    await writeFile(join(root, "note.txt"), "after\n");
    const broker = new InMemoryCapabilityBroker();
    grant(broker, { tools: ["git"], effects: ["read"], resources: ["vcs:."] });
    const registry = new ToolRegistry(broker);
    registry.register("git", gitTool);
    const advertised = identity(registry, "git");

    const status = await registry.execute(
      "git",
      advertised,
      { operation: "status" },
      context(root, artifactStore, "act_git_status"),
    );
    assert.match(status.output.stdout, /AM note\.txt/);

    const unstaged = await registry.execute(
      "git",
      advertised,
      { operation: "diff" },
      context(root, artifactStore, "act_git_diff"),
    );
    assert.match(unstaged.output.stdout, /-before/);
    assert.match(unstaged.output.stdout, /\+after/);
    assert.equal(unstaged.output.truncated, false);

    const staged = await registry.execute(
      "git",
      advertised,
      { operation: "diff-staged" },
      context(root, artifactStore, "act_git_staged"),
    );
    assert.match(staged.output.stdout, /\+before/);
  });
});

test("shell executes an argument vector without shell interpolation", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("shell", shellTool);
    const literal = "hello & echo injected";

    const settlement = await registry.execute(
      "shell",
      identity(registry, "shell"),
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", literal],
        workdir: ".",
        timeoutMs: 5_000,
      },
      context(root, artifactStore),
    );
    assert.equal(settlement.output.exitCode, 0);
    assert.equal(settlement.output.stdout, literal);
    assert.equal(settlement.output.stderr, "");
  });
});

test("shell does not inherit provider credential environment variables", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousXai = process.env.XAI_API_KEY;
    process.env.OPENAI_API_KEY = "should-not-leak";
    process.env.XAI_API_KEY = "should-not-leak-either";
    try {
      const broker = new InMemoryCapabilityBroker();
      grant(broker);
      const registry = new ToolRegistry(broker);
      registry.register("shell", shellTool);
      const settlement = await registry.execute(
        "shell",
        identity(registry, "shell"),
        {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, xai: process.env.XAI_API_KEY ?? null, qi: process.env.QI_SHELL ?? null, path: Boolean(process.env.PATH || process.env.Path) }))",
          ],
          workdir: ".",
          timeoutMs: 5_000,
        },
        context(root, artifactStore, "act_shell_env"),
      );
      assert.deepEqual(JSON.parse(settlement.output.stdout), {
        openai: null,
        xai: null,
        qi: "1",
        path: true,
      });
    } finally {
      if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAI;
      if (previousXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousXai;
    }
  });
});

test("shell omits a pre-existing Git diff when the command made no Workspace change", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "qi@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Qi Test"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "before\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "already changed\n");
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("shell", shellTool);

    const settlement = await registry.execute(
      "shell",
      identity(registry, "shell"),
      { command: process.execPath, args: ["-e", "process.stdout.write('ok')"], workdir: "." },
      context(root, artifactStore, "act_shell_no_change"),
    );
    assert.equal(settlement.output.workspaceChange.changed, false);
    assert.equal(settlement.output.workspaceChange.diff, "");
    assert.equal(settlement.output.workspaceChange.diffTruncated, false);
    assert.match(settlement.output.workspaceChange.status, /tracked\.txt/);
  });
});

test("shell resolves the npm platform shim and runs a Workspace script", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { demo: "node -e \"process.stdout.write('demo-ok')\"" },
    }));
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("shell", shellTool);

    const settlement = await registry.execute(
      "shell",
      identity(registry, "shell"),
      { command: "npm", args: ["run", "demo"], workdir: ".", timeoutMs: 30_000 },
      context(root, artifactStore, "act_shell_npm_demo"),
    );
    assert.equal(settlement.output.exitCode, 0);
    assert.match(settlement.output.stdout, /demo-ok/);
    assert.equal(settlement.output.timedOut, false);
  });
});

test("shell failures preserve process evidence and a bounded Git Workspace diff", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "qi@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Qi Test"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "before\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("shell", shellTool);

    await assert.rejects(
      registry.execute(
        "shell",
        identity(registry, "shell"),
        {
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('tracked.txt','after\\n');process.exit(7)"],
          workdir: ".",
          timeoutMs: 5_000,
        },
        context(root, artifactStore, "act_shell_failed_diff"),
      ),
      (error) => {
        assert.ok(error instanceof ToolFailure);
        assert.equal(error.code, "SHELL_EXIT_NONZERO");
        assert.equal(error.details.exitCode, 7);
        assert.equal(error.details.workspaceChange.changed, true);
        assert.match(error.details.workspaceChange.diff, /-before/);
        assert.match(error.details.workspaceChange.diff, /\+after/);
        return true;
      },
    );
  });
});

test("verify runs only a frozen repository profile with a credential-minimized environment", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await mkdir(join(root, ".qi"));
    const manifestPath = join(root, ".qi", "qi.verify.json");
    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      profiles: {
        focused: {
          description: "Run the focused verification fixture",
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ cwd: process.cwd(), verify: process.env.QI_VERIFY, openai: process.env.OPENAI_API_KEY ?? null }))",
          ],
          workdir: ".",
          timeoutMs: 5_000,
        },
      },
    }));
    const profiles = await loadVerificationProfiles(root);
    assert.equal(profiles.length, 1);
    assert.match(profiles[0].definitionSha256, /^[a-f0-9]{64}$/);

    // The manifest is mutable Workspace data, but the authorized definition is frozen at runtime startup.
    await writeFile(manifestPath, JSON.stringify({ version: 1, profiles: { focused: { command: "missing-after-load", args: [] } } }));
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("verify", createVerifyTool(profiles));
    const advertised = identity(registry, "verify");

    await assert.rejects(
      registry.execute(
        "verify",
        advertised,
        { profile: "focused", args: ["--injected"] },
        context(root, artifactStore, "act_verify_invalid"),
      ),
      (error) => error instanceof ToolInputError,
    );
    const settlement = await registry.execute(
      "verify",
      advertised,
      { profile: "focused" },
      context(root, artifactStore, "act_verify_focused"),
    );
    assert.equal(settlement.output.profile, "focused");
    assert.equal(settlement.output.definitionSha256, profiles[0].definitionSha256);
    assert.equal(settlement.output.exitCode, 0);
    assert.equal(settlement.output.timedOut, false);
    assert.equal(settlement.output.truncated, false);
    assert.deepEqual(JSON.parse(settlement.output.stdout), {
      cwd: root,
      verify: "1",
      openai: null,
    });
  });
});

test("verification preparation migrates a valid legacy root manifest into private runtime state", async () => {
  await withWorkspace(async ({ root }) => {
    const legacy = JSON.stringify({
      version: 1,
      profiles: {
        focused: { command: process.execPath, args: ["--version"], timeoutMs: 5_000 },
      },
    });
    await writeFile(join(root, "qi.verify.json"), legacy);
    const prepared = await prepareVerificationProfiles(root);
    assert.equal(prepared.origin, "migrated");
    assert.equal(prepared.manifestPath, ".qi/qi.verify.json");
    assert.deepEqual(prepared.profiles.map((profile) => profile.name), ["focused"]);
    assert.equal(await readFile(join(root, ".qi", "qi.verify.json"), "utf8"), legacy);
    assert.equal(await readFile(join(root, "qi.verify.json"), "utf8"), legacy);
  });
});

test("verification preparation generates a failing reminder when no standard check can be inferred", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    const prepared = await prepareVerificationProfiles(root);
    assert.equal(prepared.origin, "generated");
    assert.deepEqual(prepared.profiles.map((profile) => profile.name), ["configure-verification"]);
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("verify", createVerifyTool(prepared.profiles));
    await assert.rejects(
      registry.execute(
        "verify",
        identity(registry, "verify"),
        { profile: "configure-verification" },
        context(root, artifactStore, "act_verify_configuration_reminder"),
      ),
      (error) => {
        assert.ok(error instanceof ToolFailure);
        assert.equal(error.code, "VERIFY_FAILED");
        assert.equal(error.details.exitCode, 2);
        assert.match(error.details.stderr, /No verification profile is configured/);
        return true;
      },
    );
  });
});

test("artifact tool stores complete content behind a content-addressed reference", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    const broker = new InMemoryCapabilityBroker();
    grant(broker);
    const registry = new ToolRegistry(broker);
    registry.register("artifact", artifactTool);

    const settlement = await registry.execute(
      "artifact",
      identity(registry, "artifact"),
      { content: "durable evidence", mediaType: "text/plain" },
      context(root, artifactStore),
    );
    const stored = await artifactStore.get(settlement.output.ref);
    assert.equal(Buffer.from(stored.content).toString("utf8"), "durable evidence");
    assert.equal(stored.mediaType, "text/plain");
  });
});

test("leases expire and enforce use limits independently of tool schemas", async () => {
  await withWorkspace(async ({ root, artifactStore }) => {
    await writeFile(join(root, "once.txt"), "one read");
    const broker = new InMemoryCapabilityBroker();
    grant(broker, { maxUses: 1 });
    const registry = new ToolRegistry(broker);
    registry.register("read", readTool);
    const advertised = identity(registry, "read");

    await registry.execute("read", advertised, { path: "once.txt" }, context(root, artifactStore, "act_once_001"));
    await assert.rejects(
      registry.execute("read", advertised, { path: "once.txt" }, context(root, artifactStore, "act_once_002")),
      (error) => error instanceof AuthorityDeniedError,
    );
  });
});
