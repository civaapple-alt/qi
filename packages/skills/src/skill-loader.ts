import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { parseFrontmatter, requireString } from "./frontmatter.js";

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
}

export interface SkillSummary extends SkillMetadata {
  root: string;
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  resources: string[];
  evals: string[];
}

const resourceDirectories = new Set(["scripts", "references", "assets", "evals"]);

export class SkillLoader {
  readonly #maximumFileBytes: number;

  constructor(maximumFileBytes = 1_000_000) {
    this.#maximumFileBytes = maximumFileBytes;
  }

  async discover(parent: string): Promise<SkillSummary[]> {
    const entries = await readdir(resolve(parent), { withFileTypes: true });
    const summaries: SkillSummary[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const root = resolve(parent, entry.name);
      try {
        const content = await this.#readFrontmatter(resolve(root, "SKILL.md"));
        summaries.push({ ...metadata(content, `Skill ${entry.name}`), root });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return summaries;
  }

  async load(root: string): Promise<LoadedSkill> {
    const requestedRoot = resolve(root);
    if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Skill root must not be a symbolic link");
    const resolvedRoot = await realpath(requestedRoot);
    const content = await this.#readBounded(resolve(resolvedRoot, "SKILL.md"));
    const parsed = parseFrontmatter<Record<string, unknown>>(content, `Skill ${basename(resolvedRoot)}`);
    const details = metadata(content, `Skill ${basename(resolvedRoot)}`);
    const resources = await listResources(resolvedRoot);
    return {
      ...details,
      root: resolvedRoot,
      instructions: parsed.body,
      resources,
      evals: resources.filter((path) => path.startsWith("evals/")),
    };
  }

  async readResource(skill: LoadedSkill, resourcePath: string): Promise<Uint8Array> {
    const normalized = resourcePath.replaceAll("\\", "/");
    const first = normalized.split("/")[0];
    if (!first || !resourceDirectories.has(first)) throw new Error(`Skill resource must be under ${[...resourceDirectories].join(", ")}`);
    const path = resolve(skill.root, normalized);
    const prefix = skill.root.endsWith(sep) ? skill.root : `${skill.root}${sep}`;
    if (!path.startsWith(prefix)) throw new Error("Skill resource escapes its root");
    const actual = await realpath(path);
    if (!actual.startsWith(prefix)) throw new Error("Skill resource resolves outside its root");
    return this.#readBytesBounded(actual);
  }

  async #readBounded(path: string): Promise<string> {
    return Buffer.from(await this.#readBytesBounded(path)).toString("utf8");
  }

  async #readFrontmatter(path: string): Promise<string> {
    const handle = await open(path, "r");
    try {
      const maximum = Math.min(this.#maximumFileBytes, 64 * 1024);
      const buffer = Buffer.alloc(maximum);
      const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
      const prefix = buffer.subarray(0, bytesRead).toString("utf8");
      const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(prefix);
      if (!match) throw new TypeError(`${path} has no complete YAML frontmatter within ${maximum} bytes`);
      return match[0];
    } finally {
      await handle.close();
    }
  }

  async #readBytesBounded(path: string): Promise<Uint8Array> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${path} is not a file`);
    if (info.size > this.#maximumFileBytes) throw new Error(`${path} exceeds ${this.#maximumFileBytes} bytes`);
    return readFile(path);
  }
}

function metadata(content: string, label: string): SkillMetadata {
  const { metadata } = parseFrontmatter<Record<string, unknown>>(content, label);
  return {
    name: requireString(metadata.name, "name", label),
    version: metadata.version === undefined ? "unversioned" : requireString(metadata.version, "version", label),
    description: requireString(metadata.description, "description", label),
  };
}

async function listResources(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const directory of resourceDirectories) {
    const start = resolve(root, directory);
    await walk(start, root, found).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    });
  }
  return found.sort();
}

async function walk(path: string, root: string, found: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(child, root, found);
    else if (entry.isFile()) found.push(relative(root, child).replaceAll("\\", "/"));
  }
}
