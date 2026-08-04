import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { parseFrontmatter, requireString } from "./frontmatter.js";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DEFAULT_SKILL_MAX_FILES = 512;
export const DEFAULT_SKILL_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SKILL_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SKILL_MAX_DEPTH = 16;

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Readonly<Record<string, string>>;
  allowedTools?: string;
  extensions: Readonly<Record<string, unknown>>;
  warnings: readonly string[];
}

export interface SkillSummary extends SkillMetadata {
  root: string;
}

export interface SkillResource {
  path: string;
  size: number;
  mediaType: string;
  executable: boolean;
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  resources: string[];
  resourceDetails: readonly SkillResource[];
  evals: string[];
}

export interface SkillLoaderOptions {
  maximumFileBytes?: number;
  maximumFiles?: number;
  maximumTotalBytes?: number;
  maximumDepth?: number;
}

const ignoredDirectoryNames = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".cache",
]);
const knownFrontmatter = new Set([
  "name", "description", "license", "compatibility", "metadata", "allowed-tools", "version",
]);

export class SkillLoader {
  readonly #maximumFileBytes: number;
  readonly #maximumFiles: number;
  readonly #maximumTotalBytes: number;
  readonly #maximumDepth: number;

  constructor(options: number | SkillLoaderOptions = {}) {
    const normalized = typeof options === "number" ? { maximumFileBytes: options } : options;
    this.#maximumFileBytes = normalized.maximumFileBytes ?? DEFAULT_SKILL_MAX_FILE_BYTES;
    this.#maximumFiles = normalized.maximumFiles ?? DEFAULT_SKILL_MAX_FILES;
    this.#maximumTotalBytes = normalized.maximumTotalBytes ?? DEFAULT_SKILL_MAX_BYTES;
    this.#maximumDepth = normalized.maximumDepth ?? DEFAULT_SKILL_MAX_DEPTH;
  }

  async discover(parent: string): Promise<SkillSummary[]> {
    const entries = await readdir(resolve(parent), { withFileTypes: true });
    const summaries: SkillSummary[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const root = resolve(parent, entry.name);
      try {
        const content = await this.#readFrontmatter(resolve(root, "SKILL.md"));
        const details = parseSkillMetadata(content, `Skill ${entry.name}`);
        assertSkillDirectoryName(details.name, entry.name);
        summaries.push({ ...details, root });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return summaries;
  }

  /** Read only SKILL.md metadata for one known directory; resources remain undiscovered. */
  async inspect(root: string): Promise<SkillSummary> {
    const requestedRoot = resolve(root);
    const info = await lstat(requestedRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Skill root must be a real directory");
    const resolvedRoot = await realpath(requestedRoot);
    const content = await this.#readFrontmatter(resolve(resolvedRoot, "SKILL.md"));
    const details = parseSkillMetadata(content, `Skill ${basename(resolvedRoot)}`);
    assertSkillDirectoryName(details.name, basename(resolvedRoot));
    return { ...details, root: resolvedRoot };
  }

  async load(root: string, options: { enforceDirectoryName?: boolean } = {}): Promise<LoadedSkill> {
    const requestedRoot = resolve(root);
    const rootInfo = await lstat(requestedRoot);
    if (rootInfo.isSymbolicLink()) throw new Error("Skill root must not be a symbolic link");
    if (!rootInfo.isDirectory()) throw new Error("Skill root must be a real directory");
    const resolvedRoot = await realpath(requestedRoot);
    const content = await this.#readBounded(resolve(resolvedRoot, "SKILL.md"));
    const parsed = parseFrontmatter<Record<string, unknown>>(content, `Skill ${basename(resolvedRoot)}`);
    const details = parseSkillMetadata(content, `Skill ${basename(resolvedRoot)}`);
    if (options.enforceDirectoryName ?? false) assertSkillDirectoryName(details.name, basename(resolvedRoot));
    const resourceDetails = await this.#listResources(resolvedRoot);
    const resources = resourceDetails.map((entry) => entry.path);
    return {
      ...details,
      root: resolvedRoot,
      instructions: parsed.body,
      resources,
      resourceDetails,
      evals: resources.filter((path) => path.startsWith("evals/")),
    };
  }

  async readResource(skill: LoadedSkill, resourcePath: string): Promise<Uint8Array> {
    const normalized = normalizeResourcePath(resourcePath);
    if (normalized === "SKILL.md") throw new Error("Use Skill load for SKILL.md instructions");
    if (!skill.resources.includes(normalized)) throw new Error(`Unknown Skill resource: ${normalized}`);
    const path = resolve(skill.root, normalized);
    const prefix = skill.root.endsWith(sep) ? skill.root : `${skill.root}${sep}`;
    if (!path.startsWith(prefix)) throw new Error("Skill resource escapes its root");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Skill resource must be a regular non-link file");
    const actual = await realpath(path);
    if (!actual.startsWith(prefix)) throw new Error("Skill resource resolves outside its root");
    return this.#readBytesBounded(actual);
  }

  async #listResources(root: string): Promise<SkillResource[]> {
    const found: SkillResource[] = [];
    let totalBytes = 0;
    const caseFolded = new Set<string>();
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > this.#maximumDepth) throw new Error(`Skill tree exceeds depth ${this.#maximumDepth}`);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (ignoredDirectoryNames.has(entry.name)) {
          if (entry.isDirectory()) continue;
          throw new Error(`Reserved Skill cache name is not a directory: ${entry.name}`);
        }
        const child = resolve(directory, entry.name);
        const relativePath = relative(root, child).replaceAll("\\", "/");
        assertPortableSkillPath(relativePath);
        const info = await lstat(child);
        if (info.isSymbolicLink()) throw new Error(`Skill tree refuses symbolic link ${relativePath}`);
        if (info.isDirectory()) {
          await walk(child, depth + 1);
          continue;
        }
        if (!info.isFile()) throw new Error(`Skill tree contains a special file: ${relativePath}`);
        if (relativePath === "SKILL.md") continue;
        if (info.size > this.#maximumFileBytes) throw new Error(`${relativePath} exceeds ${this.#maximumFileBytes} bytes`);
        const folded = relativePath.toLocaleLowerCase("en-US");
        if (caseFolded.has(folded)) throw new Error(`Skill tree contains a case-colliding path: ${relativePath}`);
        caseFolded.add(folded);
        totalBytes += info.size;
        if (totalBytes > this.#maximumTotalBytes) throw new Error(`Skill tree exceeds ${this.#maximumTotalBytes} bytes`);
        found.push({
          path: relativePath,
          size: info.size,
          mediaType: inferMediaType(relativePath),
          executable: relativePath.startsWith("scripts/"),
        });
        if (found.length + 1 > this.#maximumFiles) throw new Error(`Skill tree exceeds ${this.#maximumFiles} files`);
      }
    };
    await walk(root, 0);
    return found;
  }

  async #readBounded(path: string): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.#readBytesBounded(path));
  }

  async #readFrontmatter(path: string): Promise<string> {
    const handle = await open(path, "r");
    try {
      const maximum = Math.min(this.#maximumFileBytes, 64 * 1024);
      const buffer = Buffer.alloc(maximum);
      const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
      const prefix = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(prefix);
      if (!match) throw new TypeError(`${path} has no complete YAML frontmatter within ${maximum} bytes`);
      return match[0];
    } finally {
      await handle.close();
    }
  }

  async #readBytesBounded(path: string): Promise<Uint8Array> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > this.#maximumFileBytes) throw new Error(`${path} exceeds ${this.#maximumFileBytes} bytes`);
    return readFile(path);
  }
}

export function parseSkillMetadata(content: string, label: string): SkillMetadata {
  const { metadata: source } = parseFrontmatter<Record<string, unknown>>(content, label);
  const name = requireString(source.name, "name", label);
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new TypeError(`${label} name must be 1-64 lowercase letters/digits joined by single hyphens`);
  }
  const description = requireString(source.description, "description", label);
  if (description.length > 1_024) throw new TypeError(`${label} description exceeds 1024 characters`);
  const compatibility = source.compatibility === undefined
    ? undefined
    : requireString(source.compatibility, "compatibility", label);
  if (compatibility && compatibility.length > 500) throw new TypeError(`${label} compatibility exceeds 500 characters`);
  const metadata = parseStringMap(source.metadata, `${label} metadata`);
  const extensions = Object.fromEntries(Object.entries(source).filter(([key]) => !knownFrontmatter.has(key)));
  const warnings = Object.keys(extensions).sort().map((key) => `Unknown frontmatter field ${key} is informational only`);
  return {
    name,
    version: source.version === undefined ? (metadata.version ?? "unversioned") : requireString(source.version, "version", label),
    description,
    ...(source.license === undefined ? {} : { license: requireString(source.license, "license", label) }),
    ...(compatibility === undefined ? {} : { compatibility }),
    metadata,
    ...(source["allowed-tools"] === undefined ? {} : {
      allowedTools: requireString(source["allowed-tools"], "allowed-tools", label),
    }),
    extensions,
    warnings,
  };
}

export function assertSkillDirectoryName(name: string, directoryName: string): void {
  if (name !== directoryName) throw new TypeError(`Skill directory ${directoryName} must match declared name ${name}`);
}

function parseStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be a string map`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new TypeError(`${label}.${key} must be a string`);
    result[key] = entry;
  }
  return Object.freeze(result);
}

function normalizeResourcePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  assertPortableSkillPath(normalized);
  return normalized;
}

function assertPortableSkillPath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Skill path escapes or is not contained by its root: ${path}`);
  }
  for (const part of path.split("/")) {
    const stem = part.split(".")[0]!.toUpperCase();
    if (/[<>:"|?*\0]/.test(part) || /[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new Error(`Skill path is not portable: ${path}`);
    }
  }
}

function inferMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md": return "text/markdown";
    case ".txt": case ".py": case ".js": case ".mjs": case ".cjs": case ".sh": case ".ps1": case ".cmd": case ".bat": return "text/plain";
    case ".json": return "application/json";
    case ".yaml": case ".yml": return "application/yaml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}
