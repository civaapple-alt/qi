import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

export interface ExportedWorkspaceSkillDraft {
  name: string;
  destination: string;
  expectedDigest: string;
  draftDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface UpdatedWorkspaceSkill extends InstalledSkill {
  previousDigest: string;
  digest: string;
  fileCount: number;
  totalBytes: number;
  recoveryMarker?: string;
}

export class SkillStaleError extends Error {
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(expectedDigest: string, actualDigest: string) {
    super(`Workspace Skill changed since the draft was exported (expected ${expectedDigest}, found ${actualDigest})`);
    this.name = "SkillStaleError";
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

export class SkillUpdateIndeterminateError extends Error {
  readonly recoveryMarker: string;

  constructor(message: string, recoveryMarker: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillUpdateIndeterminateError";
    this.recoveryMarker = recoveryMarker;
  }
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
      await copyInstallFiles(files, temporary);
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

  async exportWorkspaceDraft(name: string, destination: string): Promise<ExportedWorkspaceSkillDraft> {
    const sourceRoot = await this.#workspaceSkillRoot(name);
    const source = await this.#loader.load(sourceRoot);
    const files = await collectInstallFiles(sourceRoot);
    const digest = await digestInstallFiles(files);
    const requestedDestination = resolve(destination);
    if (await exists(requestedDestination)) {
      throw new Error(`Skill draft destination already exists: ${requestedDestination}`);
    }
    const parent = await ensureRealDirectory(dirname(requestedDestination));
    assertContained(parent, requestedDestination, "Skill draft destination");
    const temporary = resolve(parent, `.skill-draft-${name}-${randomUUID()}`);
    assertContained(parent, temporary, "Skill draft staging directory");
    try {
      await mkdir(temporary);
      await copyInstallFiles(files, temporary);
      const staged = await this.#loader.load(temporary);
      if (staged.name !== source.name || staged.description !== source.description) {
        throw new Error("Exported Skill draft metadata does not match the installed Skill");
      }
      await rename(temporary, requestedDestination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      name,
      destination: requestedDestination,
      expectedDigest: digest,
      draftDigest: digest,
      fileCount: files.length,
      totalBytes: totalInstallBytes(files),
    };
  }

  async updateWorkspace(
    name: string,
    sourceDirectory: string,
    expectedDigest: string,
  ): Promise<UpdatedWorkspaceSkill> {
    const target = await this.#workspaceSkillRoot(name);
    const currentFiles = await collectInstallFiles(target);
    const actualDigest = await digestInstallFiles(currentFiles);
    if (actualDigest !== expectedDigest) throw new SkillStaleError(expectedDigest, actualDigest);

    const sourceRoot = await validateSourceRoot(sourceDirectory);
    const candidate = await this.#loader.load(sourceRoot);
    if (candidate.name !== name) throw new Error(`Skill source declares ${candidate.name}, expected ${name}`);
    const candidateFiles = await collectInstallFiles(sourceRoot);
    const parent = await ensureRealDirectory(this.workspaceSkillsRoot);
    const operationId = randomUUID();
    const staging = resolve(parent, `.update-${name}-${operationId}`);
    const backup = resolve(parent, `.backup-${name}-${operationId}`);
    const recoveryMarker = resolve(parent, `.recovery-${name}-${operationId}.json`);
    for (const path of [staging, backup, recoveryMarker]) assertContained(parent, path, "Skill update path");

    let targetBackedUp = false;
    let targetPublished = false;
    try {
      await mkdir(staging);
      await copyInstallFiles(candidateFiles, staging);
      const staged = await this.#loader.load(staging);
      if (staged.name !== name || staged.description !== candidate.description) {
        throw new Error("Staged Skill metadata does not match the update candidate");
      }
      const stagedDigest = await digestInstallFiles(await collectInstallFiles(staging));
      await writeRecoveryMarker(recoveryMarker, {
        phase: "prepared",
        name,
        target,
        staging,
        backup,
        expectedDigest,
        stagedDigest,
      });
      const latestDigest = await digestInstallFiles(await collectInstallFiles(target));
      if (latestDigest !== expectedDigest) throw new SkillStaleError(expectedDigest, latestDigest);
      await rename(target, backup);
      targetBackedUp = true;
      await writeRecoveryMarker(recoveryMarker, {
        phase: "target-backed-up",
        name,
        target,
        staging,
        backup,
        expectedDigest,
        stagedDigest,
      });
      await rename(staging, target);
      targetPublished = true;
      await writeRecoveryMarker(recoveryMarker, {
        phase: "published",
        name,
        target,
        staging,
        backup,
        expectedDigest,
        stagedDigest,
      });
      const published = await this.#loader.load(target);
      const publishedDigest = await digestInstallFiles(await collectInstallFiles(target));
      if (published.name !== name || publishedDigest !== stagedDigest) {
        throw new Error("Published Skill failed post-update verification");
      }
      const backupRemoved = await rm(backup, { recursive: true, force: true }).then(() => true, () => false);
      const markerRemoved = backupRemoved
        ? await rm(recoveryMarker, { force: true }).then(() => true, () => false)
        : false;
      return {
        name: published.name,
        version: published.version,
        description: published.description,
        root: target,
        scope: "workspace",
        sourceRoot,
        previousDigest: actualDigest,
        digest: publishedDigest,
        fileCount: candidateFiles.length,
        totalBytes: totalInstallBytes(candidateFiles),
        ...(!backupRemoved || !markerRemoved ? { recoveryMarker } : {}),
      };
    } catch (error) {
      const restored = await restoreWorkspaceSkill({
        target,
        staging,
        backup,
        recoveryMarker,
        targetBackedUp,
        targetPublished,
      });
      if (!restored) {
        throw new SkillUpdateIndeterminateError(
          `Workspace Skill update settlement is uncertain; inspect ${recoveryMarker} before retrying`,
          recoveryMarker,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #select(name: string): Promise<CatalogSkill> {
    if (!skillNamePattern.test(name)) throw new TypeError(`Invalid Skill name: ${name}`);
    const skill = (await this.discover()).find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Skill ${name} is not installed`);
    return skill;
  }

  async #workspaceSkillRoot(name: string): Promise<string> {
    if (!skillNamePattern.test(name)) throw new TypeError(`Invalid Skill name: ${name}`);
    const parent = await ensureRealDirectory(this.workspaceSkillsRoot);
    const target = resolve(parent, name);
    assertContained(parent, target, "Workspace Skill");
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Workspace Skill must be a real directory: ${target}`);
    }
    return realpath(target);
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

async function copyInstallFiles(files: readonly InstallFile[], destinationRoot: string): Promise<void> {
  for (const file of files) {
    const destination = resolve(destinationRoot, file.relativePath);
    assertContained(destinationRoot, destination, "Skill file destination");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.path, destination);
  }
}

async function digestInstallFiles(files: readonly InstallFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(`${file.relativePath}\0${file.size}\0`);
    hash.update(await readFile(file.path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function totalInstallBytes(files: readonly InstallFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

async function writeRecoveryMarker(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`, "utf8");
}

async function restoreWorkspaceSkill(input: {
  target: string;
  staging: string;
  backup: string;
  recoveryMarker: string;
  targetBackedUp: boolean;
  targetPublished: boolean;
}): Promise<boolean> {
  try {
    const backupExists = await exists(input.backup);
    const targetExists = await exists(input.target);
    if (backupExists) {
      if (targetExists) {
        await rm(input.target, { recursive: true });
      }
      await rename(input.backup, input.target);
    } else if (!targetExists) {
      return false;
    }
    await rm(input.staging, { recursive: true, force: true });
    await rm(input.recoveryMarker, { force: true });
    return true;
  } catch {
    return false;
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
