import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { SkillLoader, type LoadedSkill, type SkillSummary } from "./skill-loader.js";

export type SkillScope = "workspace" | "user";

export interface CatalogSkill extends SkillSummary {
  scope: SkillScope;
  shadowedUserRoot?: string;
}

export interface SkillCatalogOptions {
  workspaceRoot: string;
  userHome?: string;
  userSkillsRoot?: string;
  compatibilityRoots?: readonly string[];
  loader?: SkillLoader;
}

export interface SkillInstallRequest {
  source: string;
  scope?: SkillScope;
  expectedName?: string;
}

export interface InstalledSkill extends CatalogSkill {
  sourceRoot: string;
}

const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const installDirectories = new Set(["scripts", "references", "assets", "evals", "agents"]);
const ignoredNames = new Set([".DS_Store", "__pycache__"]);
const maximumInstallFiles = 256;
const maximumInstallFileBytes = 1_000_000;
const maximumInstallBytes = 16_000_000;

export class SkillCatalog {
  readonly workspaceRoot: string;
  readonly workspaceSkillsRoot: string;
  readonly userSkillsRoot: string;
  readonly compatibilityRoots: readonly string[];
  readonly #loader: SkillLoader;

  constructor(options: SkillCatalogOptions) {
    const userHome = resolve(options.userHome ?? homedir());
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.workspaceSkillsRoot = resolve(this.workspaceRoot, ".qi", "skills");
    this.userSkillsRoot = resolve(options.userSkillsRoot ?? resolve(userHome, ".qi", "skills"));
    this.compatibilityRoots = Object.freeze((options.compatibilityRoots ?? [
      resolve(userHome, ".codex", "skills"),
      resolve(userHome, ".agents", "skills"),
    ]).map((root) => resolve(root)));
    this.#loader = options.loader ?? new SkillLoader();
  }

  async discover(): Promise<CatalogSkill[]> {
    const user = await this.#discoverScope(this.userSkillsRoot, "user");
    const workspace = await this.#discoverScope(this.workspaceSkillsRoot, "workspace");
    const active = new Map<string, CatalogSkill>();
    for (const skill of user) active.set(skill.name, skill);
    for (const skill of workspace) {
      const shadowed = active.get(skill.name);
      active.set(skill.name, {
        ...skill,
        ...(shadowed?.scope === "user" ? { shadowedUserRoot: shadowed.root } : {}),
      });
    }
    return [...active.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async load(name: string): Promise<LoadedSkill & { scope: SkillScope }> {
    const skill = await this.#select(name);
    const loaded = await this.#loader.load(skill.root);
    if (loaded.name !== skill.name) throw new Error(`Skill ${name} changed identity during loading`);
    return { ...loaded, scope: skill.scope };
  }

  async readResource(name: string, resourcePath: string): Promise<Uint8Array> {
    const loaded = await this.load(name);
    return this.#loader.readResource(loaded, resourcePath);
  }

  async install(request: SkillInstallRequest): Promise<InstalledSkill> {
    const scope = request.scope ?? "user";
    const sourceRoot = await this.#resolveSource(request.source);
    const source = await this.#loader.load(sourceRoot);
    if (!skillNamePattern.test(source.name)) {
      throw new TypeError(`Skill name must match ${skillNamePattern}: ${source.name}`);
    }
    if (request.expectedName && source.name !== request.expectedName) {
      throw new Error(`Skill source declares ${source.name}, expected ${request.expectedName}`);
    }
    const parent = await ensureRealDirectory(scope === "workspace" ? this.workspaceSkillsRoot : this.userSkillsRoot);
    const target = resolve(parent, source.name);
    assertContained(parent, target, "Skill destination");
    if (await exists(target)) throw new Error(`Skill ${source.name} is already installed in ${scope} scope`);
    const temporary = resolve(parent, `.install-${source.name}-${randomUUID()}`);
    assertContained(parent, temporary, "Skill staging directory");
    try {
      await mkdir(temporary);
      const files = await collectInstallFiles(sourceRoot);
      for (const file of files) {
        const destination = resolve(temporary, file.relativePath);
        assertContained(temporary, destination, "Skill file destination");
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(file.path, destination);
      }
      const staged = await this.#loader.load(temporary);
      if (staged.name !== source.name || staged.description !== source.description) {
        throw new Error("Installed Skill metadata does not match its source");
      }
      await rename(temporary, target);
      return {
        name: staged.name,
        version: staged.version,
        description: staged.description,
        root: target,
        scope,
        sourceRoot,
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #select(name: string): Promise<CatalogSkill> {
    if (!skillNamePattern.test(name)) throw new TypeError(`Invalid Skill name: ${name}`);
    const skill = (await this.discover()).find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Skill ${name} is not installed`);
    return skill;
  }

  async #discoverScope(root: string, scope: SkillScope): Promise<CatalogSkill[]> {
    let info;
    try {
      info = await lstat(root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${scope} Skill root must be a real directory: ${root}`);
    const summaries = await this.#loader.discover(await realpath(root));
    const names = new Set<string>();
    return summaries.map((summary) => {
      if (!skillNamePattern.test(summary.name)) throw new TypeError(`Invalid Skill name in ${root}: ${summary.name}`);
      if (names.has(summary.name)) throw new Error(`Duplicate Skill name ${summary.name} in ${scope} scope`);
      names.add(summary.name);
      return { ...summary, scope };
    });
  }

  async #resolveSource(source: string): Promise<string> {
    const requested = source.trim();
    if (!requested) throw new TypeError("Skill source must not be empty");
    const explicit = isAbsolute(requested) || requested.includes("/") || requested.includes("\\") || requested.startsWith(".");
    if (explicit) return validateSourceRoot(isAbsolute(requested) ? requested : resolve(this.workspaceRoot, requested));
    if (!skillNamePattern.test(requested)) throw new TypeError(`Invalid Skill source name: ${requested}`);
    for (const root of this.compatibilityRoots) {
      for (const candidate of [resolve(root, requested), resolve(root, ".system", requested)]) {
        if (await exists(candidate)) return validateSourceRoot(candidate);
      }
    }
    throw new Error(`Skill source ${requested} was not found; provide a local directory path`);
  }
}

interface InstallFile {
  path: string;
  relativePath: string;
  size: number;
}

async function collectInstallFiles(sourceRoot: string): Promise<InstallFile[]> {
  const root = await validateSourceRoot(sourceRoot);
  const files: InstallFile[] = [];
  await addFile(resolve(root, "SKILL.md"), "SKILL.md", files);
  for (const name of installDirectories) await walkOptional(resolve(root, name), root, files);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (/^(?:licen[cs]e|notice)(?:\.[A-Za-z0-9_-]+)?$/i.test(entry.name)) {
      if (entry.isSymbolicLink()) throw new Error(`Skill install refuses symbolic link ${entry.name}`);
      if (!entry.isFile()) continue;
      await addFile(resolve(root, entry.name), entry.name, files);
    }
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > maximumInstallFiles) throw new Error(`Skill contains more than ${maximumInstallFiles} installable files`);
  if (total > maximumInstallBytes) throw new Error(`Skill install exceeds ${maximumInstallBytes} bytes`);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walkOptional(path: string, root: string, files: InstallFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (ignoredNames.has(entry.name) || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) continue;
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill install refuses symbolic link ${relative(root, child)}`);
    if (entry.isDirectory()) await walkOptional(child, root, files);
    else if (entry.isFile()) await addFile(child, relative(root, child).replaceAll("\\", "/"), files);
  }
}

async function addFile(path: string, relativePath: string, files: InstallFile[]): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Skill install refuses symbolic link ${relativePath}`);
  if (!info.isFile()) throw new Error(`${relativePath} is not a regular file`);
  if (info.size > maximumInstallFileBytes) throw new Error(`${relativePath} exceeds ${maximumInstallFileBytes} bytes`);
  files.push({ path, relativePath, size: info.size });
}

async function validateSourceRoot(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Skill source must be a real directory: ${path}`);
  return realpath(path);
}

async function ensureRealDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  const parent = dirname(requested);
  if (parent !== requested) await ensureRealDirectory(parent);
  let info;
  try {
    info = await lstat(requested);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(requested);
    info = await lstat(requested);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Skill destination root must be a real directory: ${path}`);
  return realpath(requested);
}

function assertContained(root: string, path: string, label: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error(`${label} escapes ${root}`);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => {
    if (isMissing(error)) return false;
    throw error;
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
