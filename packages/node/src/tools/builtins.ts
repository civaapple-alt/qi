import { createHash, randomUUID } from "node:crypto";
import { realpath, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import {
  minimalHostEnvironment,
  runHostProcess,
  scrubCredentialEnvironment,
} from "@civaapple/qi-node/workspace";
import { ToolFailure } from "@civaapple/qi-agent/tools";
import { storeTruncatedOutputArtifact, truncatedOutputCaptureLimitBytes } from "./output-artifact.js";
import { defineTool, type AnyToolDefinition, type ToolExecutionContext } from "@civaapple/qi-agent/tools";
import {
  assertSensitiveContentAllowed,
  isSensitiveWorkspacePath,
  sensitivePathPolicyFromContext,
} from "./sensitive-paths.js";
import {
  applyEditsToFileContent,
  prepareEditInput,
  type EditHunk,
} from "./edit-apply.js";
import {
  formatAccessiblePath,
  isRegularFile,
  mountsFromContext,
  resolveAccessiblePath,
  resolveWorkspaceEntry,
  resolveWorkspacePath,
  type ResolvedAccessiblePath,
  type WorkspaceMount,
} from "./workspace.js";

const sha256Pattern = "^[a-f0-9]{64}$";
const ignoredWorkspaceEntries = [".git", ".qi", ".artifacts", "node_modules", "dist"] as const;
const verificationManifestLimitBytes = 64 * 1024;
export const defaultVerificationManifestPath = ".qi/qi.verify.json";
const legacyVerificationManifestPath = "qi.verify.json";

export interface VerificationProfile {
  readonly name: string;
  readonly description?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly timeoutMs: number;
  readonly definitionSha256: string;
}

export interface PreparedVerificationProfiles {
  readonly manifestPath: string;
  readonly origin: "existing" | "migrated" | "generated";
  readonly profiles: readonly VerificationProfile[];
}

type FindFileType = "file" | "directory" | "symlink";

interface FindRequest {
  pattern?: string;
  mode?: "literal" | "regex" | "glob";
  path?: string;
  type?: FindFileType;
  caseSensitive?: boolean;
  modifiedAfter?: string;
  modifiedBefore?: string;
  maxDepth?: number;
  maxResults?: number;
}

interface FindEntry {
  path: string;
  type: FindFileType;
  modifiedAt: string;
  sensitive?: boolean;
}

export const readTool = defineTool({
  description:
    "Read one known UTF-8 text file and return its content and whole-file freshness hash. " +
    "After search, prefer startLine/maxLines around the reported match instead of rereading a large file in full. " +
    "startLine is 1-based; maxLines is capped at 500 and defaults to 200 when startLine is provided. " +
    "Workspace paths are relative to the primary root; authorized read-only mounts use mount:<id>/…. " +
    "The path must be a file, never a directory; use list to discover directory entries. " +
    "Do not pass artifact:// refs here — use artifact_get for Artifact store content (including delegate resultRef).",
  input: Type.Object(
    {
      path: Type.String({ minLength: 1 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      path: Type.String(),
      content: Type.String(),
      size: Type.Integer({ minimum: 0 }),
      sha256: Type.String({ pattern: sha256Pattern }),
      startLine: Type.Integer({ minimum: 0 }),
      endLine: Type.Integer({ minimum: 0 }),
      returnedLines: Type.Integer({ minimum: 0 }),
      totalLines: Type.Integer({ minimum: 0 }),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: (input) => [`file:${input.path}`],
  async execute(input, context) {
    const request = input as { path: string; startLine?: number; maxLines?: number };
    if (request.path.startsWith("artifact://")) {
      throw new ToolFailure(
        "ARTIFACT_REF_NOT_WORKSPACE_PATH",
        "artifact:// refs are not Workspace paths. Use artifact_get to read Artifact store content.",
      );
    }
    assertSensitiveContentAllowed(request.path, context);
    const mounts = mountsFromContext(context);
    const resolved = await resolveAccessiblePath(context.workspaceRoot, request.path, mounts);
    if (!(await isRegularFile(resolved.absolute))) {
      throw new ToolFailure("NOT_A_FILE", `${request.path} is not a regular file`);
    }
    const content = await readFile(resolved.absolute, "utf8");
    const lines = textLineSpans(content);
    const totalLines = lines.length;
    const rangeRequested = request.startLine !== undefined || request.maxLines !== undefined;
    const requestedStartLine = request.startLine ?? 1;
    if (totalLines > 0 && requestedStartLine > totalLines) {
      throw new ToolFailure(
        "READ_RANGE_OUT_OF_BOUNDS",
        `startLine ${requestedStartLine} exceeds the file's ${totalLines} lines`,
        { startLine: requestedStartLine, totalLines },
      );
    }
    const maximum = rangeRequested ? (request.maxLines ?? 200) : totalLines;
    const firstIndex = totalLines === 0 ? 0 : requestedStartLine - 1;
    const selected = lines.slice(firstIndex, firstIndex + maximum);
    const selectedContent = rangeRequested && selected.length > 0
      ? content.slice(selected[0]?.start ?? 0, selected.at(-1)?.end ?? 0)
      : rangeRequested
        ? ""
        : content;
    const actualStartLine = selected.length === 0 ? 0 : requestedStartLine;
    const actualEndLine = selected.length === 0 ? 0 : requestedStartLine + selected.length - 1;
    return {
      path: formatAccessiblePath(resolved, context.workspaceRoot, mounts, resolved.absolute),
      content: selectedContent,
      size: Buffer.byteLength(content),
      sha256: hash(content),
      startLine: actualStartLine,
      endLine: actualEndLine,
      returnedLines: selected.length,
      totalLines,
      truncated: selected.length < totalLines,
    };
  },
});

export const listTool = defineTool({
  description:
    "List bounded file and directory names under one Workspace or mount:<id>/ directory. " +
    "Use this for discovery; it does not read file contents. Recursive listing is opt-in.",
  input: Type.Object(
    {
      path: Type.Optional(Type.String({ minLength: 1 })),
      recursive: Type.Optional(Type.Boolean()),
      maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      entries: Type.Array(
        Type.Object(
          {
            path: Type.String(),
            type: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
            sensitive: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      ),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: (input) => [`tree:${input.path ?? "."}`],
  async execute(input, context) {
    const request = input as { path?: string; recursive?: boolean; maxEntries?: number };
    const mounts = mountsFromContext(context);
    const policy = sensitivePathPolicyFromContext(context);
    const resolved = await resolveAccessiblePath(context.workspaceRoot, request.path ?? ".", mounts);
    const rootInfo = await stat(resolved.absolute);
    if (!rootInfo.isDirectory()) {
      throw new ToolFailure("NOT_A_DIRECTORY", `${request.path ?? "."} is not a directory`);
    }
    const maximum = request.maxEntries ?? 200;
    const entries: Array<{ path: string; type: "file" | "directory"; sensitive?: boolean }> = [];
    let truncated = false;

    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (ignoredWorkspaceEntry(child.name) || child.isSymbolicLink()) continue;
        if (entries.length >= maximum) {
          truncated = true;
          return;
        }
        const childPath = resolve(directory, child.name);
        if (!child.isDirectory() && !child.isFile()) continue;
        const path = formatAccessiblePath(resolved, context.workspaceRoot, mounts, childPath);
        const sensitive = child.isFile() && isSensitiveWorkspacePath(path, policy);
        entries.push({
          path,
          type: child.isDirectory() ? "directory" : "file",
          ...(sensitive ? { sensitive: true } : {}),
        });
        if (request.recursive && child.isDirectory()) {
          await visit(childPath);
          if (truncated) return;
        }
      }
    };

    await visit(resolved.absolute);
    return { entries, truncated };
  },
});

export const writeTool = defineTool({
  description: "Atomically create or intentionally replace one complete UTF-8 file inside the Workspace using a required freshness assertion. Use edit for a precise change to an existing file.",
  input: Type.Object(
    {
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      expectedSha256: Type.Union([Type.String({ pattern: sha256Pattern }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      path: Type.String(),
      size: Type.Integer({ minimum: 0 }),
      sha256: Type.String({ pattern: sha256Pattern }),
      previousSha256: Type.Union([Type.String({ pattern: sha256Pattern }), Type.Null()]),
      created: Type.Boolean(),
      diff: Type.String(),
      diffTruncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  effect: () => "write",
  resources: (input) => [`file:${input.path}`],
  async execute(input, context) {
    const requested = input as { path: string; content: string; expectedSha256: string | null };
    assertSensitiveContentAllowed(requested.path, context);
    let path: string;
    let exists = true;
    try {
      path = await resolveWorkspaceEntry(context.workspaceRoot, requested.path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      path = await resolveWorkspacePath(context.workspaceRoot, requested.path, true);
      exists = false;
    }
    if (exists && !(await isRegularFile(path))) {
      throw new ToolFailure("NOT_A_FILE", `${requested.path} is not a regular file`);
    }
    let previousContent = "";
    let previousSha256: string | null = null;
    let previousMode: number | undefined;
    if (exists) {
      previousMode = (await stat(path)).mode & 0o777;
      previousContent = await readFile(path, "utf8");
      previousSha256 = hash(previousContent);
      if (requested.expectedSha256 !== previousSha256) {
        throw new ToolFailure("STALE_READ", `Expected ${requested.expectedSha256 ?? "a missing file"}, found ${previousSha256}`);
      }
    } else if (requested.expectedSha256 !== null) {
      throw new ToolFailure("STALE_READ", "The file is missing but the write expected an existing version");
    }

    await atomicWriteText(path, requested.content, previousMode);
    const renderedDiff = replacementDiff(requested.path, previousContent, requested.content, exists);
    return {
      path: requested.path,
      size: Buffer.byteLength(requested.content),
      sha256: hash(requested.content),
      previousSha256,
      created: !exists,
      diff: renderedDiff.text,
      diffTruncated: renderedDiff.truncated,
    };
  },
});

export const editTool = defineTool({
  description:
    "Edit one existing UTF-8 file with one or more exact text replacements after verifying its freshness hash. " +
    "Pass disjoint edits[] hunks matched against the original file snapshot in a single call; merge nearby or " +
    "overlapping changes into one hunk instead of chaining same-file edit Actions. Prefer one multi-hunk call " +
    "over several edits to the same path in one Step. Each oldText must be unique unless the call has exactly " +
    "one hunk and replaceAll is true. LF/CRLF differences and a limited fuzzy ladder (trailing whitespace, " +
    "smart quotes/dashes) are reconciled; other whitespace stays exact. Reread and retry after a mismatch; " +
    "use write only for new files or intentional full replacement, and do not use shell as a file-edit fallback.",
  input: Type.Object(
    {
      path: Type.String({ minLength: 1 }),
      expectedSha256: Type.String({ pattern: sha256Pattern }),
      edits: Type.Array(
        Type.Object(
          {
            oldText: Type.String({ minLength: 1, maxLength: 1_000_000 }),
            newText: Type.String({ maxLength: 1_000_000 }),
            replaceAll: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 32 },
      ),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      path: Type.String(),
      size: Type.Integer({ minimum: 0 }),
      sha256: Type.String({ pattern: sha256Pattern }),
      previousSha256: Type.String({ pattern: sha256Pattern }),
      replacements: Type.Integer({ minimum: 1 }),
      diff: Type.String(),
      diffTruncated: Type.Boolean(),
      freshnessRebased: Type.Optional(Type.Literal(true)),
      rebasedFromSha256: Type.Optional(Type.String({ pattern: sha256Pattern })),
      rebasedAfterActionId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  prepareInput: prepareEditInput,
  effect: () => "write",
  resources: (input) => [`file:${input.path}`],
  async execute(input, context) {
    const requested = input as {
      path: string;
      expectedSha256: string;
      edits: EditHunk[];
    };
    assertSensitiveContentAllowed(requested.path, context);
    const path = await resolveWorkspaceEntry(context.workspaceRoot, requested.path);
    if (!(await isRegularFile(path))) throw new ToolFailure("NOT_A_FILE", `${requested.path} is not a regular file`);
    const previousMode = (await stat(path)).mode & 0o777;
    const previousContent = await readFile(path, "utf8");
    const previousSha256 = hash(previousContent);
    if (previousSha256 !== requested.expectedSha256) {
      throw new ToolFailure("STALE_READ", `Expected ${requested.expectedSha256}, found ${previousSha256}`);
    }
    const applied = applyEditsToFileContent(previousContent, requested.edits);
    await atomicWriteText(path, applied.content, previousMode);
    const renderedDiff = replacementDiff(requested.path, previousContent, applied.content, true);
    return {
      path: requested.path,
      size: Buffer.byteLength(applied.content),
      sha256: hash(applied.content),
      previousSha256,
      replacements: applied.replacements,
      diff: renderedDiff.text,
      diffTruncated: renderedDiff.truncated,
      ...(context.freshnessRebase === undefined ? {} : {
        freshnessRebased: true as const,
        rebasedFromSha256: context.freshnessRebase.originalExpectedSha256,
        rebasedAfterActionId: context.freshnessRebase.priorActionId,
      }),
    };
  },
});

export const moveTool = defineTool({
  description: "Atomically move one existing regular file to a missing Workspace path after verifying the source freshness hash. Directories, symbolic links, overwrites, and paths outside the Workspace are rejected.",
  input: Type.Object(
    {
      from: Type.String({ minLength: 1 }),
      to: Type.String({ minLength: 1 }),
      expectedSha256: Type.String({ pattern: sha256Pattern }),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      from: Type.String(),
      to: Type.String(),
      size: Type.Integer({ minimum: 0 }),
      sha256: Type.String({ pattern: sha256Pattern }),
    },
    { additionalProperties: false },
  ),
  effect: () => "write",
  resources: (input) => [`file:${input.from}`, `file:${input.to}`],
  async execute(input, context) {
    const requested = input as { from: string; to: string; expectedSha256: string };
    if (requested.from === requested.to) throw new ToolFailure("NO_CHANGE", "Move source and destination are identical");
    const source = await resolveWorkspaceEntry(context.workspaceRoot, requested.from);
    if (!(await isRegularFile(source))) throw new ToolFailure("NOT_A_FILE", `${requested.from} is not a regular file`);
    const destination = await resolveWorkspacePath(context.workspaceRoot, requested.to, true);
    if (await pathExists(destination)) throw new ToolFailure("TARGET_EXISTS", `${requested.to} already exists`);
    const content = await readFile(source);
    const sha256 = hash(content);
    if (sha256 !== requested.expectedSha256) {
      throw new ToolFailure("STALE_READ", `Expected ${requested.expectedSha256}, found ${sha256}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    return { from: requested.from, to: requested.to, size: content.byteLength, sha256 };
  },
});

export const removeTool = defineTool({
  description: "Remove one existing regular file after verifying its freshness hash. Before deletion, the complete bytes are stored as a recoverable Artifact. Directories, symbolic links, and paths outside the Workspace are rejected.",
  input: Type.Object(
    {
      path: Type.String({ minLength: 1 }),
      expectedSha256: Type.String({ pattern: sha256Pattern }),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      path: Type.String(),
      size: Type.Integer({ minimum: 0 }),
      previousSha256: Type.String({ pattern: sha256Pattern }),
      backupRef: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
    },
    { additionalProperties: false },
  ),
  effect: () => "write",
  resources: (input) => [`file:${input.path}`, "artifact-store:local"],
  async execute(input, context) {
    const requested = input as { path: string; expectedSha256: string };
    const path = await resolveWorkspaceEntry(context.workspaceRoot, requested.path);
    if (!(await isRegularFile(path))) throw new ToolFailure("NOT_A_FILE", `${requested.path} is not a regular file`);
    const content = await readFile(path);
    const previousSha256 = hash(content);
    if (previousSha256 !== requested.expectedSha256) {
      throw new ToolFailure("STALE_READ", `Expected ${requested.expectedSha256}, found ${previousSha256}`);
    }
    const backup = await context.artifactStore.put(content, "application/octet-stream");
    await rm(path);
    return {
      path: requested.path,
      size: content.byteLength,
      previousSha256,
      backupRef: backup.ref,
    };
  },
});

export const searchTool = defineTool({
  description: "Search file contents with ripgrep speed and ignore semantics. Literal mode is the safe default; regex mode and bounded include/exclude globs are explicit. This searches content, not filenames; use find for filename, type, or modification-time queries.",
  input: Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 1_000 }),
      path: Type.Optional(Type.String({ minLength: 1 })),
      mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex")])),
      caseSensitive: Type.Optional(Type.Boolean()),
      globs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      matches: Type.Array(
        Type.Object(
          { path: Type.String(), line: Type.Integer({ minimum: 1 }), text: Type.String() },
          { additionalProperties: false },
        ),
      ),
      truncated: Type.Boolean(),
      engine: Type.Union([Type.Literal("rg"), Type.Literal("node")]),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: (input) => [`tree:${input.path ?? "."}`],
  async execute(input, context) {
    const request = input as {
      query: string;
      path?: string;
      mode?: "literal" | "regex";
      caseSensitive?: boolean;
      globs?: string[];
      maxResults?: number;
    };
    assertSensitiveContentAllowed(request.path ?? ".", context);
    const scope = await resolvePathScope(context, request.path ?? ".");
    const policy = sensitivePathPolicyFromContext(context);
    const grants = new Set(
      (context.getSensitivePathGrants?.() ?? context.sensitivePathGrants ?? []).map((path) =>
        path.replace(/\\/g, "/").replace(/^\.\//, ""),
      ),
    );
    const allowContentPath = (toolPath: string): boolean => {
      if (!isSensitiveWorkspacePath(toolPath, policy)) return true;
      return grants.has(toolPath.replace(/\\/g, "/").replace(/^\.\//, ""));
    };
    const maximum = request.maxResults ?? 100;
    const ripgrep = await findTrustedExecutable("rg", scope.processRoot);
    if (ripgrep) {
      const result = await searchWithRipgrep(ripgrep, request, scope, maximum, context.signal);
      const matches = result.matches.filter((match) => allowContentPath(match.path));
      return {
        matches,
        truncated: result.truncated || matches.length < result.matches.length,
        engine: result.engine,
      };
    }
    if (request.globs?.length) throw new ToolFailure("RG_UNAVAILABLE", "Glob content search requires ripgrep on PATH");
    let matchesLine: (line: string) => boolean;
    if (request.mode === "regex") {
      let expression: RegExp;
      try {
        expression = new RegExp(request.query, request.caseSensitive ? "" : "i");
      } catch (error) {
        throw new ToolFailure("INVALID_PATTERN", error instanceof Error ? error.message : String(error));
      }
      matchesLine = (line) => expression.test(line);
    } else {
      const needle = request.caseSensitive ? request.query : request.query.toLocaleLowerCase();
      matchesLine = (line) => (request.caseSensitive ? line : line.toLocaleLowerCase()).includes(needle);
    }
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = false;

    for await (const file of walkFiles(scope.startAbsolute)) {
      const toolPath = scope.formatPath(file);
      if (!allowContentPath(toolPath)) continue;
      const info = await stat(file);
      if (info.size > 1_000_000) continue;
      const buffer = await readFile(file);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] ?? "";
        if (!matchesLine(text)) continue;
        if (matches.length === maximum) {
          truncated = true;
          return { matches, truncated, engine: "node" as const };
        }
        matches.push({
          path: toolPath,
          line: index + 1,
          text,
        });
      }
    }
    return { matches, truncated, engine: "node" as const };
  },
});

export const findTool = defineTool({
  description:
    "Find Workspace entries by filename/path pattern, file type, modification-time bounds, and depth. " +
    "Uses fd when available, respects ignore files and hidden-file defaults, and returns bounded structured metadata. " +
    "Default matching is literal substring; patterns with *, ?, [], or {} (for example `**/*.md` or `**/*.{sql,md}`) " +
    "are treated as globs unless mode is set. Use mode=regex only for real regular expressions such as `\\.ts$`. " +
    "This does not search file contents; use search for that.",
  input: Type.Object(
    {
      pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex"), Type.Literal("glob")])),
      path: Type.Optional(Type.String({ minLength: 1 })),
      type: Type.Optional(Type.Union([
        Type.Literal("file"),
        Type.Literal("directory"),
        Type.Literal("symlink"),
      ])),
      caseSensitive: Type.Optional(Type.Boolean()),
      modifiedAfter: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      modifiedBefore: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      entries: Type.Array(Type.Object(
        {
          path: Type.String(),
          type: Type.Union([
            Type.Literal("file"),
            Type.Literal("directory"),
            Type.Literal("symlink"),
          ]),
          modifiedAt: Type.String(),
          sensitive: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      )),
      truncated: Type.Boolean(),
      engine: Type.Union([Type.Literal("fd"), Type.Literal("node")]),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: (input) => [`tree:${input.path ?? "."}`],
  async execute(input, context) {
    return findWorkspaceEntries(input as FindRequest, context, context.signal);
  },
});

export const treeTool = defineTool({
  description:
    "Render a bounded, ignore-aware directory tree for the Workspace or a mount:<id>/ path. " +
    "Depth and entry limits are required runtime boundaries; use find for targeted filename or metadata queries.",
  input: Type.Object(
    {
      path: Type.Optional(Type.String({ minLength: 1 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      directoriesOnly: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      root: Type.String(),
      tree: Type.String(),
      entryCount: Type.Integer({ minimum: 0 }),
      truncated: Type.Boolean(),
      engine: Type.Union([Type.Literal("fd"), Type.Literal("node")]),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: (input) => [`tree:${input.path ?? "."}`],
  async execute(input, context) {
    const request = input as {
      path?: string;
      maxDepth?: number;
      maxEntries?: number;
      directoriesOnly?: boolean;
    };
    const root = request.path ?? ".";
    const scope = await resolvePathScope(context, root);
    if (!(await stat(scope.startAbsolute)).isDirectory()) {
      throw new ToolFailure("NOT_A_DIRECTORY", `${root} is not a directory`);
    }
    const result = await findWorkspaceEntries(
      {
        path: root,
        pattern: ".",
        mode: "regex",
        ...(request.directoriesOnly ? { type: "directory" as const } : {}),
        maxDepth: request.maxDepth ?? 3,
        maxResults: request.maxEntries ?? 200,
      },
      context,
      context.signal,
    );
    return {
      root: scope.formatPath(scope.startAbsolute),
      tree: renderDirectoryTree(scope, result.entries),
      entryCount: result.entries.length,
      truncated: result.truncated,
      engine: result.engine,
    };
  },
});

export const shellTool = defineTool({
  description:
    "Execute one finite program with a direct argument vector in the Workspace; command contains only the executable name or path, while every flag and path operand is a separate args item. Do not put a whole command line such as mkdir -p pepsi-3d-2/src in command; use write to create files and their parent directories. Shell interpolation, wildcard/glob expansion, pipes, and redirection are not available. Pass the target directory through workdir and invoke package managers directly (for example command npm with args [\"run\",\"build\"]), rather than wrapping the command in bash, cmd, or PowerShell. On Windows, programs that need the null device must use NUL instead of /dev/null. Multiple shell Actions may share a workdir in one Step (they still run sequentially). Prefer one authorized script Action when you need shell builtins, pipes, or multi-statement logic. " +
    "Do not use shell for resident session entrypoints that stay alive (for example agent-browser open); those require the background task/Jobs tool. Use shell only for finite attaching commands such as agent-browser snapshot, click, screenshot, session, or close. " +
    "Use find/search/read for file inspection, qi_session_inspect for Session diagnostics, and an authorized script profile instead of a long node -e program. Non-zero exits, unavailable executables, process-start failures, and timeouts fail the Action. In a Git Workspace, Qi records bounded before/after state fingerprints and the resulting tracked diff.",
  input: Type.Object(
    {
      command: Type.String({ minLength: 1 }),
      args: Type.Array(Type.String(), { maxItems: 200 }),
      workdir: Type.Optional(Type.String({ minLength: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      exitCode: Type.Union([Type.Integer(), Type.Null()]),
      stdout: Type.String(),
      stderr: Type.String(),
      timedOut: Type.Boolean(),
      truncated: Type.Boolean(),
      outputRef: Type.Optional(Type.String({ pattern: "^artifact://[a-f0-9]{64}$" })),
      workspaceChange: Type.Optional(Type.Object(
        {
          changed: Type.Boolean(),
          beforeSha256: Type.String({ pattern: sha256Pattern }),
          afterSha256: Type.String({ pattern: sha256Pattern }),
          status: Type.String(),
          diff: Type.String(),
          diffTruncated: Type.Boolean(),
        },
        { additionalProperties: false },
      )),
    },
    { additionalProperties: false },
  ),
  effect: () => "execute",
  resources: (input) => {
    const request = input as { command: string; workdir?: string };
    return [
      `host-process:${request.command}`,
      `host-workspace:${request.workdir ?? "."}`,
      "shell-profile:direct",
    ];
  },
  async execute(input, context) {
    const request = input as { command: string; args: string[]; workdir?: string; timeoutMs?: number };
    const workdir = request.workdir ?? ".";
    const cwd = await resolveWorkspacePath(context.workspaceRoot, workdir);
    if (!(await stat(cwd)).isDirectory()) {
      throw new ToolFailure("NOT_A_DIRECTORY", `${workdir} is not a directory`);
    }
    const executable = await resolveShellExecutable(request.command, context.workspaceRoot, cwd);
    const invocation = await windowsCommandInvocation(
      executable,
      request.args,
      context.workspaceRoot,
      "UNSAFE_SHELL_ARGUMENT",
    );
    const before = await observeGitWorkspace(context.workspaceRoot, context.signal);
    let processResult: Awaited<ReturnType<typeof runHostProcess>>;
    try {
      processResult = await runHostProcess(invocation.command, invocation.args, {
        cwd,
        timeoutMs: request.timeoutMs ?? 30_000,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        env: scrubCredentialEnvironment(process.env, { QI_SHELL: "1", NO_COLOR: "1" }),
        outputLimitBytes: 64 * 1024,
        captureLimitBytes: truncatedOutputCaptureLimitBytes,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(context.reportActivity === undefined ? {} : { reportActivity: context.reportActivity }),
      });
    } catch (error) {
      if (isProcessStartError(error)) {
        throw new ToolFailure(
          "SHELL_START_FAILED",
          `Could not start ${request.command}: ${errorMessage(error)}`,
          { command: request.command, code: error.code },
        );
      }
      throw error;
    }
    const { stdoutFull, stderrFull, ...result } = processResult;
    const after = await observeGitWorkspace(context.workspaceRoot, context.signal);
    const workspaceChange = before && after
      ? (() => {
          const changed = before.sha256 !== after.sha256;
          return {
            changed,
            beforeSha256: before.sha256,
            afterSha256: after.sha256,
            status: after.status,
            diff: changed ? after.diff : "",
            diffTruncated: changed ? after.truncated : false,
          };
        })()
      : undefined;
    const artifactRef = await storeTruncatedOutputArtifact(context, { truncated: result.truncated, stdoutFull, stderrFull });
    const output = { ...result, ...artifactRef, ...(workspaceChange === undefined ? {} : { workspaceChange }) };
    if (result.timedOut) {
      throw new ToolFailure("SHELL_TIMEOUT", `Process exceeded ${request.timeoutMs ?? 30_000} ms`, output);
    }
    if (result.exitCode !== 0) {
      throw new ToolFailure("SHELL_EXIT_NONZERO", `Process exited with code ${String(result.exitCode)}`, output);
    }
    return output;
  },
});

export async function loadVerificationProfiles(
  workspaceRoot: string,
  manifestPath = defaultVerificationManifestPath,
): Promise<readonly VerificationProfile[]> {
  let path: string;
  try {
    path = await resolveWorkspaceEntry(
      workspaceRoot,
      manifestPath,
      manifestPath === defaultVerificationManifestPath,
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ToolFailure("VERIFY_CONFIG_MISSING", `${manifestPath} is required when declared verification is enabled`);
    }
    throw error;
  }
  const info = await lstat(path);
  if (!info.isFile()) throw new ToolFailure("INVALID_VERIFY_CONFIG", `${manifestPath} must be a regular file`);
  if (info.size > verificationManifestLimitBytes) {
    throw new ToolFailure("VERIFY_CONFIG_TOO_LARGE", `${manifestPath} exceeds ${verificationManifestLimitBytes} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ToolFailure("INVALID_VERIFY_CONFIG", `${manifestPath} is not valid JSON: ${errorMessage(error)}`);
  }
  const root = requireRecord(decoded, manifestPath);
  assertOnlyKeys(root, ["version", "profiles"], manifestPath);
  if (root.version !== 1) throw new ToolFailure("INVALID_VERIFY_CONFIG", `${manifestPath} version must be 1`);
  const configured = requireRecord(root.profiles, `${manifestPath}.profiles`);
  const entries = Object.entries(configured);
  if (entries.length === 0 || entries.length > 32) {
    throw new ToolFailure("INVALID_VERIFY_CONFIG", `${manifestPath} must declare between 1 and 32 profiles`);
  }
  const profiles: VerificationProfile[] = [];
  for (const [name, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new ToolFailure("INVALID_VERIFY_CONFIG", `Invalid verification profile name: ${name}`);
    }
    const profile = requireRecord(value, `${manifestPath}.profiles.${name}`);
    assertOnlyKeys(profile, ["description", "command", "args", "workdir", "timeoutMs"], `${manifestPath}.profiles.${name}`);
    const configuredCommand = requireBoundedString(profile.command, `${name}.command`, 1, 1_024);
    const command = await resolveVerificationExecutable(configuredCommand, workspaceRoot);
    if (!Array.isArray(profile.args) || profile.args.length > 200) {
      throw new ToolFailure("INVALID_VERIFY_CONFIG", `${name}.args must be an array of at most 200 strings`);
    }
    const args = profile.args.map((argument, index) => requireBoundedString(argument, `${name}.args[${index}]`, 0, 4_096));
    const workdir = profile.workdir === undefined
      ? "."
      : requireBoundedString(profile.workdir, `${name}.workdir`, 1, 1_024);
    const workdirPath = await resolveWorkspacePath(workspaceRoot, workdir);
    if (!(await stat(workdirPath)).isDirectory()) {
      throw new ToolFailure("INVALID_VERIFY_CONFIG", `${name}.workdir must be a Workspace directory`);
    }
    const timeoutMs = profile.timeoutMs === undefined ? 30_000 : profile.timeoutMs;
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 120_000) {
      throw new ToolFailure("INVALID_VERIFY_CONFIG", `${name}.timeoutMs must be an integer from 1 to 120000`);
    }
    const description = profile.description === undefined
      ? undefined
      : requireBoundedString(profile.description, `${name}.description`, 1, 500);
    const definition = { command, args, workdir, timeoutMs: timeoutMs as number };
    profiles.push(Object.freeze({
      name,
      ...(description === undefined ? {} : { description }),
      ...definition,
      args: Object.freeze([...args]),
      definitionSha256: hash(JSON.stringify(definition)),
    }));
  }
  return Object.freeze(profiles.sort((left, right) => left.name.localeCompare(right.name)));
}

export async function prepareVerificationProfiles(workspaceRoot: string): Promise<PreparedVerificationProfiles> {
  await ensurePrivateQiDirectory(workspaceRoot);
  if (await workspaceEntryExists(workspaceRoot, defaultVerificationManifestPath, true)) {
    if (await isGeneratedConfigurationReminder(workspaceRoot)) {
      const inferred = await inferVerificationManifest(workspaceRoot);
      if (!("configure-verification" in inferred.profiles)) {
        const target = await resolveWorkspacePath(workspaceRoot, defaultVerificationManifestPath, true, true);
        await atomicWriteText(target, `${JSON.stringify(inferred, null, 2)}\n`);
        return {
          manifestPath: defaultVerificationManifestPath,
          origin: "generated",
          profiles: await loadVerificationProfiles(workspaceRoot),
        };
      }
    }
    return {
      manifestPath: defaultVerificationManifestPath,
      origin: "existing",
      profiles: await loadVerificationProfiles(workspaceRoot),
    };
  }
  if (await workspaceEntryExists(workspaceRoot, legacyVerificationManifestPath, false)) {
    await loadVerificationProfiles(workspaceRoot, legacyVerificationManifestPath);
    const legacy = await resolveWorkspaceEntry(workspaceRoot, legacyVerificationManifestPath);
    const target = await resolveWorkspacePath(workspaceRoot, defaultVerificationManifestPath, true, true);
    await atomicWriteText(target, await readFile(legacy, "utf8"));
    return {
      manifestPath: defaultVerificationManifestPath,
      origin: "migrated",
      profiles: await loadVerificationProfiles(workspaceRoot),
    };
  }
  const generated = await inferVerificationManifest(workspaceRoot);
  const target = await resolveWorkspacePath(workspaceRoot, defaultVerificationManifestPath, true, true);
  await atomicWriteText(target, `${JSON.stringify(generated, null, 2)}\n`);
  return {
    manifestPath: defaultVerificationManifestPath,
    origin: "generated",
    profiles: await loadVerificationProfiles(workspaceRoot),
  };
}

export function createVerifyTool(profiles: readonly VerificationProfile[]): AnyToolDefinition {
  if (profiles.length === 0) throw new TypeError("At least one verification profile is required");
  const frozenProfiles = profiles.map((profile) => {
    const definition = {
      command: profile.command,
      args: [...profile.args],
      workdir: profile.workdir,
      timeoutMs: profile.timeoutMs,
    };
    const definitionSha256 = hash(JSON.stringify(definition));
    if (profile.definitionSha256 !== definitionSha256) {
      throw new TypeError(`Verification profile ${profile.name} has an invalid definition hash`);
    }
    return Object.freeze({ ...profile, ...definition, args: Object.freeze(definition.args) });
  });
  const byName = new Map(frozenProfiles.map((profile) => [profile.name, profile]));
  if (byName.size !== profiles.length) throw new TypeError("Verification profile names must be unique");
  const literals = frozenProfiles.map((profile) => Type.Literal(profile.name));
  const profileSchema = literals.length === 1 ? literals[0]! : Type.Union(literals);
  return defineTool({
    description: [
      "Run one repository-declared verification profile. The command, arguments, working directory, timeout, and definition hash were frozen before the Agent Run; no arbitrary command input is accepted.",
      ...frozenProfiles.map((profile) => `- ${profile.name}${profile.description ? `: ${profile.description}` : ""}`),
    ].join("\n"),
    input: Type.Object({ profile: profileSchema }, { additionalProperties: false }),
    output: Type.Object(
      {
        profile: profileSchema,
        definitionSha256: Type.String({ pattern: sha256Pattern }),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stdout: Type.String(),
        stderr: Type.String(),
        timedOut: Type.Boolean(),
        truncated: Type.Boolean(),
        outputRef: Type.Optional(Type.String({ pattern: "^artifact://[a-f0-9]{64}$" })),
        durationMs: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    effect: () => "execute",
    resources: (input) => {
      const profile = byName.get((input as { profile: string }).profile);
      if (!profile) throw new ToolFailure("UNKNOWN_VERIFY_PROFILE", "Unknown verification profile");
      return [verificationResource(profile)];
    },
    async execute(input, context) {
      const profile = byName.get((input as { profile: string }).profile);
      if (!profile) throw new ToolFailure("UNKNOWN_VERIFY_PROFILE", "Unknown verification profile");
      const cwd = await resolveWorkspacePath(context.workspaceRoot, profile.workdir);
      const executable = await resolveVerificationExecutable(profile.command, context.workspaceRoot);
      const invocation = await windowsCommandInvocation(
        executable,
        profile.args,
        context.workspaceRoot,
        "UNSAFE_VERIFY_ARGUMENT",
      );
      const startedAt = Date.now();
      const { stdoutFull, stderrFull, ...result } = await runProcess(
        invocation.command,
        invocation.args,
        cwd,
        profile.timeoutMs,
        context.signal,
        verificationEnvironment(),
        64 * 1024,
        invocation.windowsVerbatimArguments,
        context.reportActivity,
        truncatedOutputCaptureLimitBytes,
      );
      const artifactRef = await storeTruncatedOutputArtifact(context, { truncated: result.truncated, stdoutFull, stderrFull });
      const output = {
        profile: profile.name,
        definitionSha256: profile.definitionSha256,
        ...result,
        ...artifactRef,
        durationMs: Date.now() - startedAt,
      };
      if (result.timedOut) {
        throw new ToolFailure("VERIFY_TIMEOUT", `Verification profile ${profile.name} exceeded ${profile.timeoutMs} ms`, output);
      }
      if (result.exitCode !== 0) {
        throw new ToolFailure("VERIFY_FAILED", `Verification profile ${profile.name} exited with code ${String(result.exitCode)}`, output);
      }
      return output;
    },
  }) as AnyToolDefinition;
}

export function verificationResource(profile: VerificationProfile): string {
  return `verification:${profile.name}:${profile.definitionSha256}`;
}

const gitReadOperations = [
  "status",
  "diff",
  "diff-staged",
  "log",
  "rev-parse",
  "show",
  "branch",
  "remote",
] as const;
type GitReadOperation = (typeof gitReadOperations)[number];

const gitRefOperations = new Set<GitReadOperation>(["rev-parse", "show"]);
const gitMaxCountOperations = new Set<GitReadOperation>(["log"]);

/** Reject option-like tokens, ranges, and odd ref syntax before argv construction. */
function assertSafeGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new ToolFailure("INVALID_GIT_REF", "Git ref must be 1-256 characters");
  }
  if (trimmed !== ref) {
    throw new ToolFailure("INVALID_GIT_REF", "Git ref may not include leading or trailing whitespace");
  }
  if (trimmed.startsWith("-") || trimmed.includes("\0") || /\s/.test(trimmed) || trimmed.includes("..")) {
    throw new ToolFailure(
      "INVALID_GIT_REF",
      "Git ref must be a single revision (no options, whitespace, or ranges)",
    );
  }
  if (
    !/^(?:HEAD(?:[~^][0-9]*)*|refs\/[A-Za-z0-9._\-\/]+|[0-9a-f]{4,40}|[A-Za-z0-9][A-Za-z0-9._\-\/]*)$/.test(
      trimmed,
    )
  ) {
    throw new ToolFailure("INVALID_GIT_REF", `Unsupported Git ref syntax: ${trimmed}`);
  }
  return trimmed;
}

/** Operator-visible request summary; includes rejected extras so failures show the full call. */
function formatGitToolRequest(
  operation: string,
  options: { ref?: string; maxCount?: number },
): string {
  const parts = [`git ${operation}`];
  if (options.ref !== undefined) parts.push(`ref ${options.ref}`);
  if (options.maxCount !== undefined) parts.push(`maxCount ${options.maxCount}`);
  return parts.join(" · ");
}

function gitFailureDetails(
  operation: string,
  options: { ref?: string; maxCount?: number },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    command: formatGitToolRequest(operation, options),
    operation,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.maxCount === undefined ? {} : { maxCount: options.maxCount }),
    ...extra,
  };
}

function gitInspectionArgs(
  operation: GitReadOperation,
  options: { ref?: string; maxCount?: number },
): readonly string[] {
  if (options.ref !== undefined && !gitRefOperations.has(operation)) {
    throw new ToolFailure(
      "INVALID_GIT_ARGUMENT",
      `ref is only valid for rev-parse and show`,
      gitFailureDetails(operation, options),
    );
  }
  if (options.maxCount !== undefined && !gitMaxCountOperations.has(operation)) {
    throw new ToolFailure(
      "INVALID_GIT_ARGUMENT",
      `maxCount is only valid for log`,
      gitFailureDetails(operation, options),
    );
  }
  switch (operation) {
    case "status":
      return ["status", "--short", "--branch", "--untracked-files=all"];
    case "diff":
      return ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"];
    case "diff-staged":
      return ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--"];
    case "log":
      return ["log", "--oneline", "--no-color", "-n", String(options.maxCount ?? 10), "--"];
    case "rev-parse":
      return ["rev-parse", "--verify", `${assertSafeGitRef(options.ref ?? "HEAD")}^{commit}`];
    case "show":
      return [
        "show",
        "-s",
        "--format=medium",
        "--stat",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        assertSafeGitRef(options.ref ?? "HEAD"),
      ];
    case "branch":
      return ["branch", "-vv", "--no-color"];
    case "remote":
      return ["remote", "-v"];
  }
}

export const gitTool = defineTool({
  description:
    "Inspect the Workspace Git repository without changing it. Operations are fixed to status, unstaged/staged diff, " +
    "oneline log, rev-parse, show (commit metadata + stat), branch, or remote; arbitrary Git arguments and mutating " +
    "commands are not accepted. Prefer this tool over shell for repository inspection.",
  input: Type.Object(
    {
      operation: Type.Union(gitReadOperations.map((operation) => Type.Literal(operation))),
      ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      maxCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      operation: Type.Union(gitReadOperations.map((operation) => Type.Literal(operation))),
      stdout: Type.String(),
      stderr: Type.String(),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: () => ["vcs:."],
  async execute(input, context) {
    const request = input as { operation: GitReadOperation; ref?: string; maxCount?: number };
    const options = {
      ...(request.ref === undefined ? {} : { ref: request.ref }),
      ...(request.maxCount === undefined ? {} : { maxCount: request.maxCount }),
    };
    const git = await resolveTrustedExecutable("git", context.workspaceRoot);
    let operationArgs: readonly string[];
    try {
      operationArgs = gitInspectionArgs(request.operation, options);
    } catch (error) {
      if (error instanceof ToolFailure && error.code === "INVALID_GIT_REF") {
        throw new ToolFailure(
          error.code,
          error.message,
          gitFailureDetails(request.operation, options),
        );
      }
      throw error;
    }
    const argv = ["-c", "core.fsmonitor=false", "--no-pager", ...operationArgs];
    const command = ["git", ...argv].join(" ");
    const result = await runProcess(
      git,
      argv,
      context.workspaceRoot,
      30_000,
      context.signal,
      { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    );
    if (result.timedOut) {
      throw new ToolFailure(
        "GIT_TIMEOUT",
        "Git inspection exceeded 30 seconds",
        gitFailureDetails(request.operation, options, { command, argv }),
      );
    }
    if (result.exitCode !== 0) {
      throw new ToolFailure(
        "GIT_FAILED",
        result.stderr.trim() || `Git exited with code ${result.exitCode}`,
        gitFailureDetails(request.operation, options, {
          command,
          argv,
          exitCode: result.exitCode,
        }),
      );
    }
    return {
      operation: request.operation,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  },
});

export const artifactTool = defineTool({
  description:
    "Store complete text in Qi's machine-private content-addressed Artifact store and return its durable reference. " +
    "This does not create or modify a Workspace file and must not be used as a substitute for write/edit.",
  input: Type.Object(
    { content: Type.String(), mediaType: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      ref: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
      size: Type.Integer({ minimum: 0 }),
      sha256: Type.String({ pattern: sha256Pattern }),
    },
    { additionalProperties: false },
  ),
  effect: () => "write",
  resources: (input) => {
    const request = input as { content: string };
    return [`artifact-store:local:${hash(request.content)}`];
  },
  async execute(input, context) {
    const request = input as { content: string; mediaType: string };
    return context.artifactStore.put(Buffer.from(request.content), request.mediaType);
  },
});

const artifactGetMaxCharsDefault = 100_000;

export const artifactGetTool = defineTool({
  description:
    "Read content from Qi's machine-private content-addressed Artifact store by artifact:// reference. " +
    "Use for delegate resultRef (full child deliverable) or summaryRef (short preview). " +
    "This is not a Workspace file tool — do not use read with artifact:// paths.",
  input: Type.Object(
    {
      ref: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
      maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 200_000 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      ref: Type.String({ pattern: "^artifact://[a-f0-9]{64}$" }),
      content: Type.String(),
      mediaType: Type.String(),
      size: Type.Integer({ minimum: 0 }),
      sha256: Type.String({ pattern: sha256Pattern }),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  effect: () => "read",
  resources: (input) => {
    const request = input as { ref: string };
    const digest = request.ref.slice("artifact://".length);
    return [`artifact-store:local:${digest}`, `artifact:${digest}`];
  },
  async execute(input, context) {
    const request = input as { ref: string; maxChars?: number };
    const stored = await context.artifactStore.get(request.ref);
    const digest = request.ref.slice("artifact://".length);
    const text = Buffer.from(stored.content).toString("utf8");
    const maxChars = request.maxChars ?? artifactGetMaxCharsDefault;
    const truncated = text.length > maxChars;
    return {
      ref: request.ref,
      content: truncated ? text.slice(0, maxChars) : text,
      mediaType: stored.mediaType,
      size: stored.content.byteLength,
      sha256: digest,
      truncated,
    };
  },
});

export const builtinTools = {
  read: readTool as AnyToolDefinition,
  list: listTool,
  write: writeTool,
  edit: editTool,
  move: moveTool,
  remove: removeTool,
  search: searchTool,
  find: findTool,
  tree: treeTool,
  git: gitTool,
  shell: shellTool,
  artifact: artifactTool,
  artifact_get: artifactGetTool as AnyToolDefinition,
} as const;

function hash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function atomicWriteText(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.qi-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function textLineSpans(content: string): Array<{ start: number; end: number }> {
  if (!content) return [];
  const spans: Array<{ start: number; end: number }> = [];
  const newline = /\r\n|\r|\n/g;
  let start = 0;
  for (const match of content.matchAll(newline)) {
    const end = (match.index ?? start) + match[0].length;
    spans.push({ start, end });
    start = end;
  }
  if (start < content.length) spans.push({ start, end: content.length });
  return spans;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateQiDirectory(workspaceRoot: string): Promise<void> {
  const root = await realpath(workspaceRoot);
  const directory = resolve(root, ".qi");
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ToolFailure("INVALID_QI_DIRECTORY", ".qi must be a real directory, not a file or symbolic link");
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await mkdir(directory, { recursive: false });
  }
}

async function workspaceEntryExists(
  workspaceRoot: string,
  requested: string,
  allowProtected: boolean,
): Promise<boolean> {
  try {
    await resolveWorkspaceEntry(workspaceRoot, requested, allowProtected);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function inferVerificationManifest(workspaceRoot: string): Promise<{
  version: 1;
  profiles: Record<string, { description: string; command: string; args: string[]; timeoutMs: number }>;
}> {
  const profiles: Record<string, { description: string; command: string; args: string[]; timeoutMs: number }> = {};
  const packageManifest = await readPackageManifest(workspaceRoot);
  if (packageManifest) {
    const manager = await inferPackageManager(workspaceRoot, packageManifest.packageManager);
    for (const name of ["test", "typecheck", "lint", "check"] as const) {
      if (typeof packageManifest.scripts?.[name] !== "string" || !packageManifest.scripts[name]?.trim()) continue;
      profiles[name] = {
        description: `Run the repository ${name} script inferred from package.json`,
        command: manager,
        args: ["run", name],
        timeoutMs: 120_000,
      };
    }
  }
  if (
    await workspaceEntryExists(workspaceRoot, "pom.xml", false)
    && await findTrustedExecutable("mvn", workspaceRoot) !== undefined
  ) {
    const name = profiles.test === undefined ? "test" : "maven-test";
    profiles[name] = {
      description: "Run the Maven test lifecycle inferred from pom.xml",
      command: "mvn",
      args: ["-q", "test"],
      timeoutMs: 120_000,
    };
  }
  if (Object.keys(profiles).length === 0) {
    profiles["configure-verification"] = {
      description: "No standard verification command was inferred; edit .qi/qi.verify.json before relying on completion",
      command: "node",
      args: [
        "-e",
        "process.stderr.write('No verification profile is configured. Edit .qi/qi.verify.json.\\n'); process.exit(2);",
      ],
      timeoutMs: 5_000,
    };
  }
  return { version: 1, profiles };
}

async function isGeneratedConfigurationReminder(workspaceRoot: string): Promise<boolean> {
  try {
    const path = await resolveWorkspaceEntry(workspaceRoot, defaultVerificationManifestPath, true);
    const decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const profiles = (decoded as { profiles?: unknown }).profiles;
    if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) return false;
    const entries = Object.entries(profiles);
    if (entries.length !== 1 || entries[0]?.[0] !== "configure-verification") return false;
    const profile = entries[0][1];
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return false;
    const value = profile as Record<string, unknown>;
    return Object.keys(value).length === 4
      && value.description === "No standard verification command was inferred; edit .qi/qi.verify.json before relying on completion"
      && value.command === "node"
      && Array.isArray(value.args)
      && value.args.length === 2
      && value.args[0] === "-e"
      && value.args[1] === "process.stderr.write('No verification profile is configured. Edit .qi/qi.verify.json.\\n'); process.exit(2);"
      && value.timeoutMs === 5_000;
  } catch {
    return false;
  }
}

async function readPackageManifest(workspaceRoot: string): Promise<{
  packageManager?: string;
  scripts?: Record<string, unknown>;
} | undefined> {
  if (!(await workspaceEntryExists(workspaceRoot, "package.json", false))) return undefined;
  const path = await resolveWorkspaceEntry(workspaceRoot, "package.json");
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024) return undefined;
  try {
    const decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const record = decoded as Record<string, unknown>;
    return {
      ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}),
      ...(typeof record.scripts === "object" && record.scripts !== null && !Array.isArray(record.scripts)
        ? { scripts: record.scripts as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

async function inferPackageManager(workspaceRoot: string, declared: string | undefined): Promise<string> {
  const declaredName = declared?.split("@", 1)[0];
  if (declaredName === "npm" || declaredName === "pnpm" || declaredName === "yarn" || declaredName === "bun") {
    return declaredName;
  }
  if (await workspaceEntryExists(workspaceRoot, "pnpm-lock.yaml", false)) return "pnpm";
  if (await workspaceEntryExists(workspaceRoot, "yarn.lock", false)) return "yarn";
  if (
    await workspaceEntryExists(workspaceRoot, "bun.lock", false) ||
    await workspaceEntryExists(workspaceRoot, "bun.lockb", false)
  ) return "bun";
  return "npm";
}

function replacementDiff(
  path: string,
  before: string,
  after: string,
  existed: boolean,
): { text: string; truncated: boolean } {
  const complete = createTwoFilesPatch(
    existed ? `a/${path}` : "/dev/null",
    `b/${path}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  );
  const maximumCharacters = 16_000;
  if (complete.length <= maximumCharacters) return { text: complete, truncated: false };
  return {
    text: `${complete.slice(0, maximumCharacters)}\n... diff truncated by Qi ...`,
    truncated: true,
  };
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  const info = await stat(root);
  if (info.isFile()) {
    yield root;
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (ignoredWorkspaceEntry(entry.name)) continue;
    const path = `${root}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

function ignoredWorkspaceEntry(name: string): boolean {
  return (ignoredWorkspaceEntries as readonly string[]).includes(name);
}

interface PathScope {
  readonly resolved: ResolvedAccessiblePath;
  readonly mounts: readonly WorkspaceMount[];
  readonly workspaceRoot: string;
  readonly startAbsolute: string;
  readonly processRoot: string;
  formatPath(absolute: string): string;
  resolveLogicalAbsolute(logicalPath: string): string;
}

async function resolvePathScope(context: ToolExecutionContext, requested: string): Promise<PathScope> {
  const mounts = mountsFromContext(context);
  const resolved = await resolveAccessiblePath(context.workspaceRoot, requested, mounts);
  const mount = resolved.mountId ? mounts.find((candidate) => candidate.id === resolved.mountId) : undefined;
  const processRoot = resolved.rootKind === "mount" && mount
    ? await realpath(mount.path)
    : await realpath(context.workspaceRoot);
  return {
    resolved,
    mounts,
    workspaceRoot: context.workspaceRoot,
    startAbsolute: resolved.absolute,
    processRoot,
    formatPath: (absolute) => formatAccessiblePath(resolved, context.workspaceRoot, mounts, absolute),
    resolveLogicalAbsolute: (logicalPath) => {
      if (resolved.rootKind === "mount" && mount) {
        const prefix = `mount:${mount.id}/`;
        const rest = logicalPath.startsWith(prefix)
          ? logicalPath.slice(prefix.length)
          : logicalPath === `mount:${mount.id}` || logicalPath === `mount:${mount.id}/`
            ? "."
            : logicalPath;
        return resolve(processRoot, rest || ".");
      }
      return resolve(context.workspaceRoot, logicalPath);
    },
  };
}

async function searchWithRipgrep(
  executable: string,
  request: {
    query: string;
    mode?: "literal" | "regex";
    caseSensitive?: boolean;
    globs?: string[];
  },
  scope: PathScope,
  maximum: number,
  signal?: AbortSignal,
): Promise<{
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
  engine: "rg";
}> {
  const searchRoot = workspaceRelative(scope.processRoot, scope.startAbsolute);
  const args = [
    "--no-config",
    "--json",
    "--color",
    "never",
    "--max-filesize",
    "1M",
    "--max-count",
    String(maximum + 1),
    request.mode === "regex" ? "--no-fixed-strings" : "--fixed-strings",
    request.caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  for (const glob of request.globs ?? []) args.push("--glob", glob);
  for (const name of ignoredWorkspaceEntries) args.push("--glob", `!**/${name}/**`);
  args.push("--", request.query, searchRoot);
  const result = await runProcess(
    executable,
    args,
    scope.processRoot,
    30_000,
    signal,
    { ...process.env, RIPGREP_CONFIG_PATH: "" },
    2 * 1024 * 1024,
  );
  if (result.timedOut) throw new ToolFailure("RG_TIMEOUT", "Content search exceeded 30 seconds");
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new ToolFailure("RG_FAILED", result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
  }
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const message = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string; bytes?: string };
          lines?: { text?: string; bytes?: string };
          line_number?: number;
        };
      };
      if (message.type !== "match" || !message.data?.path || !message.data.lines || !message.data.line_number) continue;
      const relativePath = normalizeDiscoveredPath(scope.processRoot, decodeSearchData(message.data.path));
      const text = decodeSearchData(message.data.lines).replace(/[\r\n]+$/, "");
      matches.push({
        path: scope.formatPath(resolve(scope.processRoot, relativePath)),
        line: message.data.line_number,
        text: truncateText(text, 2_000),
      });
    } catch {
      // A truncated final JSON line is accounted for by the truncated flag below.
    }
  }
  matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  return {
    matches: matches.slice(0, maximum),
    truncated: matches.length > maximum || result.truncated,
    engine: "rg",
  };
}

function resolveFindMode(request: FindRequest): "literal" | "regex" | "glob" {
  if (request.mode) return request.mode;
  // Models commonly pass shell globs; treating those as regex makes fd fail with FD_FAILED.
  if (request.pattern && looksLikeGlobPattern(request.pattern)) return "glob";
  return "literal";
}

function looksLikeGlobPattern(pattern: string): boolean {
  return /(?:^|[^\\])(?:\*|\?|\[|\{|\*\*)/.test(pattern);
}

async function findWorkspaceEntries(
  request: FindRequest,
  context: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<{ entries: FindEntry[]; truncated: boolean; engine: "fd" | "node" }> {
  const scope = await resolvePathScope(context, request.path ?? ".");
  if (!(await stat(scope.startAbsolute)).isDirectory()) {
    throw new ToolFailure("NOT_A_DIRECTORY", `${request.path ?? "."} is not a directory`);
  }
  const policy = sensitivePathPolicyFromContext(context);
  const markSensitive = (entries: FindEntry[]): FindEntry[] => entries.map((entry) => {
    if (entry.type !== "file" || !isSensitiveWorkspacePath(entry.path, policy)) return entry;
    return { ...entry, sensitive: true };
  });
  const bounds = parseModificationBounds(request.modifiedAfter, request.modifiedBefore);
  const maximum = request.maxResults ?? 100;
  const fd = await findTrustedExecutable("fd", scope.processRoot);
  if (!fd) {
    const nodeResult = await findWithNode(request, scope, bounds, maximum);
    return { ...nodeResult, entries: markSensitive(nodeResult.entries) };
  }

  const mode = resolveFindMode(request);
  const args = [
    "--color",
    "never",
    "--print0",
    "--max-results",
    String(maximum + 1),
    mode === "literal" ? "--fixed-strings" : mode === "glob" ? "--glob" : "--regex",
    request.caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  for (const name of ignoredWorkspaceEntries) args.push("--exclude", name);
  if (request.type) args.push("--type", request.type);
  if (request.maxDepth !== undefined) args.push("--max-depth", String(request.maxDepth));
  if (bounds.after) args.push("--changed-within", bounds.after.toISOString());
  if (bounds.before) args.push("--changed-before", bounds.before.toISOString());
  args.push("--", request.pattern ?? ".", workspaceRelative(scope.processRoot, scope.startAbsolute));
  const result = await runProcess(fd, args, scope.processRoot, 30_000, signal, undefined, 1024 * 1024);
  if (result.timedOut) throw new ToolFailure("FD_TIMEOUT", "File discovery exceeded 30 seconds");
  if (result.exitCode !== 0) {
    throw new ToolFailure("FD_FAILED", result.stderr.trim() || `fd exited with code ${result.exitCode}`);
  }
  const paths = result.stdout.split("\0").filter(Boolean);
  const entries: FindEntry[] = [];
  for (const path of paths.slice(0, maximum)) {
    const relativePath = normalizeDiscoveredPath(scope.processRoot, path);
    const absolute = resolve(scope.processRoot, relativePath);
    const info = await lstat(absolute);
    entries.push({ path: scope.formatPath(absolute), type: fileType(info), modifiedAt: info.mtime.toISOString() });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    entries: markSensitive(entries),
    truncated: paths.length > maximum || result.truncated,
    engine: "fd",
  };
}

async function findWithNode(
  request: FindRequest,
  scope: PathScope,
  bounds: { after?: Date; before?: Date },
  maximum: number,
): Promise<{ entries: FindEntry[]; truncated: boolean; engine: "node" }> {
  let matcher: (path: string) => boolean;
  const mode = resolveFindMode(request);
  if (!request.pattern) {
    matcher = () => true;
  } else if (mode === "literal") {
    const pattern = request.caseSensitive ? request.pattern : request.pattern.toLocaleLowerCase();
    matcher = (path) => (request.caseSensitive ? path : path.toLocaleLowerCase()).includes(pattern);
  } else if (mode === "glob") {
    const pattern = request.pattern;
    matcher = (path) => {
      try {
        return matchesGlob(path, pattern) || matchesGlob(basename(path), pattern);
      } catch (error) {
        throw new ToolFailure("INVALID_PATTERN", error instanceof Error ? error.message : String(error));
      }
    };
  } else {
    let expression: RegExp;
    try {
      expression = new RegExp(request.pattern, request.caseSensitive ? "" : "i");
    } catch (error) {
      throw new ToolFailure("INVALID_PATTERN", error instanceof Error ? error.message : String(error));
    }
    matcher = (path) => expression.test(path);
  }

  const entries: FindEntry[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (request.maxDepth !== undefined && depth >= request.maxDepth) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (ignoredWorkspaceEntry(child.name)) continue;
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      const type = fileType(info);
      const relativeToStart = relative(scope.startAbsolute, absolute).replaceAll("\\", "/");
      const withinBounds = (!bounds.after || info.mtime > bounds.after)
        && (!bounds.before || info.mtime < bounds.before);
      if ((!request.type || request.type === type) && withinBounds && matcher(relativeToStart)) {
        entries.push({
          path: scope.formatPath(absolute),
          type,
          modifiedAt: info.mtime.toISOString(),
        });
        if (entries.length > maximum) return;
      }
      if (type === "directory") {
        await visit(absolute, depth + 1);
        if (entries.length > maximum) return;
      }
    }
  };
  await visit(scope.startAbsolute, 0);
  return { entries: entries.slice(0, maximum), truncated: entries.length > maximum, engine: "node" };
}

function renderDirectoryTree(
  scope: PathScope,
  entries: readonly FindEntry[],
): string {
  interface TreeNode {
    type: FindFileType;
    sensitive?: boolean;
    children: Map<string, TreeNode>;
  }
  const root: TreeNode = { type: "directory", children: new Map() };
  for (const entry of entries) {
    const absolute = scope.resolveLogicalAbsolute(entry.path);
    const withinRoot = relative(scope.startAbsolute, absolute).replaceAll("\\", "/");
    if (!withinRoot || withinRoot.startsWith("..")) continue;
    const parts = withinRoot.split("/").filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) continue;
      let child = current.children.get(part);
      if (!child) {
        child = {
          type: index === parts.length - 1 ? entry.type : "directory",
          children: new Map(),
          ...(index === parts.length - 1 && entry.sensitive ? { sensitive: true } : {}),
        };
        current.children.set(part, child);
      } else if (index === parts.length - 1 && entry.sensitive) {
        child.sensitive = true;
      }
      current = child;
    }
  }
  const lines = [scope.formatPath(scope.startAbsolute)];
  const renderChildren = (node: TreeNode, prefix: string): void => {
    const children = [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right));
    children.forEach(([name, child], index) => {
      const last = index === children.length - 1;
      const marker = child.sensitive ? " [sensitive]" : "";
      lines.push(`${prefix}${last ? "└──" : "├──"} ${name}${child.type === "directory" ? "/" : ""}${marker}`);
      renderChildren(child, `${prefix}${last ? "    " : "│   "}`);
    });
  };
  renderChildren(root, "");
  return lines.join("\n");
}

function parseModificationBounds(
  after: string | undefined,
  before: string | undefined,
): { after?: Date; before?: Date } {
  const parsedAfter = after === undefined ? undefined : new Date(after);
  const parsedBefore = before === undefined ? undefined : new Date(before);
  if (parsedAfter && !Number.isFinite(parsedAfter.getTime())) throw new ToolFailure("INVALID_TIME", `Invalid modifiedAfter: ${after}`);
  if (parsedBefore && !Number.isFinite(parsedBefore.getTime())) throw new ToolFailure("INVALID_TIME", `Invalid modifiedBefore: ${before}`);
  if (parsedAfter && parsedBefore && parsedAfter >= parsedBefore) {
    throw new ToolFailure("INVALID_TIME_RANGE", "modifiedAfter must be earlier than modifiedBefore");
  }
  return {
    ...(parsedAfter === undefined ? {} : { after: parsedAfter }),
    ...(parsedBefore === undefined ? {} : { before: parsedBefore }),
  };
}

function normalizeDiscoveredPath(workspaceRoot: string, path: string): string {
  const absolute = resolve(workspaceRoot, path);
  const normalized = relative(resolve(workspaceRoot), absolute).replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("..") || isAbsolute(normalized)) {
    throw new ToolFailure("PATH_OUTSIDE_WORKSPACE", `Discovered path escapes Workspace: ${path}`);
  }
  return normalized;
}

function workspaceRelative(workspaceRoot: string, path: string): string {
  return relative(resolve(workspaceRoot), resolve(path)).replaceAll("\\", "/") || ".";
}

function fileType(info: Awaited<ReturnType<typeof lstat>>): FindFileType {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  return "file";
}

function decodeSearchData(data: { text?: string; bytes?: string }): string {
  if (data.text !== undefined) return data.text;
  if (data.bytes !== undefined) return Buffer.from(data.bytes, "base64").toString("utf8");
  return "";
}

function truncateText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
  outputLimitBytes = 64 * 1024,
  windowsVerbatimArguments = false,
  reportActivity?: (activity: { type: "output"; stream: "stdout" | "stderr"; text: string; truncated: boolean }) => void,
  captureLimitBytes?: number,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  stdoutFull?: string;
  stderrFull?: string;
}> {
  return runHostProcess(command, args, {
    cwd,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    env: environment ?? scrubCredentialEnvironment(),
    outputLimitBytes,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    ...(reportActivity === undefined ? {} : { reportActivity }),
    ...(captureLimitBytes === undefined ? {} : { captureLimitBytes }),
  });
}

interface GitWorkspaceSnapshot {
  sha256: string;
  status: string;
  diff: string;
  truncated: boolean;
}

async function observeGitWorkspace(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<GitWorkspaceSnapshot | undefined> {
  const git = await findTrustedExecutable("git", workspaceRoot);
  if (!git) return undefined;
  const environment = scrubCredentialEnvironment(process.env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  });
  try {
    const status = await runProcess(
      git,
      ["-c", "core.fsmonitor=false", "--no-pager", "status", "--short", "--untracked-files=all"],
      workspaceRoot,
      10_000,
      signal,
      environment,
      32 * 1024,
    );
    if (status.timedOut || status.exitCode !== 0) return undefined;
    let diff = await runProcess(
      git,
      ["-c", "core.fsmonitor=false", "--no-pager", "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--"],
      workspaceRoot,
      10_000,
      signal,
      environment,
      32 * 1024,
    );
    if (diff.timedOut || diff.exitCode !== 0) {
      diff = await runProcess(
        git,
        ["-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"],
        workspaceRoot,
        10_000,
        signal,
        environment,
        32 * 1024,
      );
    }
    if (diff.timedOut || diff.exitCode !== 0) return undefined;
    const state = `${status.stdout}\0${diff.stdout}`;
    return {
      sha256: hash(state),
      status: status.stdout,
      diff: diff.stdout,
      truncated: status.truncated || diff.truncated,
    };
  } catch {
    return undefined;
  }
}

export async function windowsCommandInvocation(
  executable: string,
  args: readonly string[],
  workspaceRoot: string,
  unsafeArgumentCode: "UNSAFE_SHELL_ARGUMENT" | "UNSAFE_VERIFY_ARGUMENT",
): Promise<{ command: string; args: readonly string[]; windowsVerbatimArguments?: boolean }> {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args };
  }
  const unsafe = args.find((argument) => /[\r\n&|<>^%!()"]/.test(argument));
  if (unsafe !== undefined) {
    throw new ToolFailure(
      unsafeArgumentCode,
      "Windows batch command arguments may not contain shell metacharacters; use a direct executable for complex arguments",
    );
  }
  const commandProcessor = await resolveVerificationExecutable(process.env.ComSpec ?? "cmd", workspaceRoot);
  const commandLine = [`"${executable}"`, ...args.map((argument) => `"${argument}"`)].join(" ");
  return {
    command: commandProcessor,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export async function resolveShellExecutable(
  command: string,
  workspaceRoot: string,
  executionDirectory = workspaceRoot,
): Promise<string> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = isAbsolute(command) ? command : resolve(executionDirectory, command);
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not a file");
      return candidate;
    } catch {
      throw new ToolFailure(
        "SHELL_COMMAND_UNAVAILABLE",
        `Executable path is unavailable: ${command}. Put flags and path operands in args instead of command`,
      );
    }
  }
  if (/\s/.test(command)) {
    throw new ToolFailure(
      "INVALID_SHELL_COMMAND",
      "command must contain only one executable name; put flags and path operands in args",
    );
  }
  return resolveTrustedExecutable(command, workspaceRoot);
}

async function resolveVerificationExecutable(command: string, workspaceRoot: string): Promise<string> {
  if (!isAbsolute(command)) {
    if (command.includes("/") || command.includes("\\")) {
      throw new ToolFailure("INVALID_VERIFY_COMMAND", "Verification commands must be bare executable names or absolute paths");
    }
    return resolveTrustedExecutable(command, workspaceRoot);
  }
  try {
    const executable = await realpath(command);
    if (isInsideWorkspace(workspaceRoot, executable)) {
      throw new ToolFailure("UNTRUSTED_VERIFY_COMMAND", "The verification executable must live outside the Workspace");
    }
    if (!(await stat(executable)).isFile()) throw new Error("not a file");
    return executable;
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure("VERIFY_COMMAND_UNAVAILABLE", `Verification executable is unavailable: ${command}`);
  }
}

function verificationEnvironment(): NodeJS.ProcessEnv {
  return minimalHostEnvironment({ CI: "true", QI_VERIFY: "1", NO_COLOR: "1" });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolFailure("INVALID_VERIFY_CONFIG", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ToolFailure("INVALID_VERIFY_CONFIG", `${label} has unknown keys: ${unexpected.join(", ")}`);
  }
}

function requireBoundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new ToolFailure("INVALID_VERIFY_CONFIG", `${label} must be a string of ${minimum}-${maximum} characters without NUL bytes`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isProcessStartError(error: unknown): error is NodeJS.ErrnoException & { syscall: string } {
  return error instanceof Error
    && "code" in error
    && "syscall" in error
    && typeof (error as NodeJS.ErrnoException).code === "string"
    && typeof (error as NodeJS.ErrnoException).syscall === "string"
    && (error as NodeJS.ErrnoException).syscall!.startsWith("spawn ");
}

async function resolveTrustedExecutable(command: string, workspaceRoot: string): Promise<string> {
  const executable = await findTrustedExecutable(command, workspaceRoot);
  if (executable) return executable;
  throw new ToolFailure(
    `${command.toLocaleUpperCase()}_UNAVAILABLE`,
    `No trusted ${command} executable was found outside the Workspace`,
  );
}

// PATH-resolved trusted-executable lookups are pure for the lifetime of a stable PATH: the same
// command/workspaceRoot/PATH triple always resolves to the same outside-Workspace binary (or absence).
// Every search/find/shell/script/verify call — and both Git snapshots around every shell call — resolved
// this independently before, which is pure repeated filesystem overhead. Cache by value, including the
// current PATH string in the key so a real PATH change (rare mid-process) transparently misses instead of
// requiring manual invalidation. Cache the in-flight Promise (not just the settled value) so concurrent
// callers for the same key share one probe instead of racing duplicate filesystem walks.
const trustedExecutableCache = new Map<string, Promise<string | undefined>>();

export async function findTrustedExecutable(command: string, workspaceRoot: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const cacheKey = `${command}::${resolve(workspaceRoot)}::${pathValue}`;
  const cached = trustedExecutableCache.get(cacheKey);
  if (cached) return cached;
  const probe = probeTrustedExecutable(command, workspaceRoot, pathValue);
  trustedExecutableCache.set(cacheKey, probe);
  try {
    return await probe;
  } catch (error) {
    trustedExecutableCache.delete(cacheKey);
    throw error;
  }
}

async function probeTrustedExecutable(
  command: string,
  workspaceRoot: string,
  pathValue: string,
): Promise<string | undefined> {
  const extensions = process.platform === "win32"
    ? (/\.[A-Za-z0-9]+$/.test(command)
        ? [""]
        : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean))
    : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension.toLocaleLowerCase()}`);
      try {
        const resolvedCandidate = await realpath(candidate);
        if (isInsideWorkspace(workspaceRoot, resolvedCandidate)) continue;
        if ((await stat(resolvedCandidate)).isFile()) return resolvedCandidate;
      } catch {
        // Continue through PATH candidates; absence is expected.
      }
    }
  }
  return undefined;
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relation = relative(resolve(workspaceRoot), candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * Warm the trusted-executable cache for the language stack detected in this Workspace, so the first real
 * `search`/`find`/`shell`/`script`/`verify` call does not pay PATH-walk latency. This only populates
 * `findTrustedExecutable`'s cache in parallel at startup; it never changes resolution logic, never registers a
 * Tool, and silently leaves a command unresolved (same fallback behavior `search`/`find` already have when
 * `rg`/`fd` are absent). Extend the candidate table here as more ecosystems (Python, Go, Rust, ...) are recognized.
 */
export async function prewarmTrustedExecutables(workspaceRoot: string): Promise<void> {
  const candidates = new Set<string>(["git", ...(process.platform === "win32" ? ["pwsh", "cmd"] : ["bash"])]);
  const [packageManifest, hasMavenProject] = await Promise.all([
    readPackageManifest(workspaceRoot).catch(() => undefined),
    workspaceEntryExists(workspaceRoot, "pom.xml", false).catch(() => false),
  ]);
  if (packageManifest) for (const command of ["node", "npm", "npx"]) candidates.add(command);
  if (hasMavenProject) for (const command of ["mvn", "jar", "javap"]) candidates.add(command);
  await Promise.all(
    [...candidates].map((command) => findTrustedExecutable(command, workspaceRoot).catch(() => undefined)),
  );
}
