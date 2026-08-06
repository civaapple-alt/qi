import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_SKILL_MAX_BYTES,
  DEFAULT_SKILL_MAX_FILE_BYTES,
  DEFAULT_SKILL_MAX_FILES,
  SKILL_NAME_PATTERN,
  SkillLoader,
  assertSkillDirectoryName,
  type LoadedSkill,
  type SkillSummary,
} from "./skill-loader.js";
import {
  acquireImmutableSkillSource,
  resolveGithubSkillSource,
  type ImmutableSkillSource,
  type SkillSourceProvenance,
} from "./source.js";
import {
  agentSkillLockHash,
  readAgentSkillActivations,
  readAgentSkillLock,
  writeAgentSkillActivations,
  type AgentSkillLockEntry,
} from "./activation.js";

export type SkillScope = "workspace" | "user";
export type SkillOrigin = "qi" | "agent";

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export interface CatalogSkill extends SkillSummary {
  scope: SkillScope;
  origin: SkillOrigin;
  shadowedUserRoot?: string;
}

/** Metadata-only Skill visible in a generic Agent directory; it is not loadable until migrated. */
export interface CompatibilitySkill extends SkillSummary {
  readonly source: "compatibility";
}

/** Global .agents Skill metadata gated by the user's explicit activation state. */
export interface AgentSkillCandidate extends SkillSummary {
  readonly source: "global-agent";
  readonly lockHash: string;
  readonly activationPath: string;
}

export interface SkillCatalogOptions {
  workspaceRoot: string;
  userHome?: string;
  userSkillsRoot?: string;
  userAgentSkillsRoot?: string;
  workspaceAgentSkillsRoot?: string;
  agentSkillsEnabled?: boolean;
  userAgentLockPath?: string;
  agentActivationPath?: string;
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
  digest: string;
  source: SkillSourceProvenance | { type: "local"; resolved: string; subdir: string };
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

const skillNamePattern = SKILL_NAME_PATTERN;
const rejectedDirectoryNames = new Set([".git", ".hg", ".svn", "node_modules"]);
const ignoredNames = new Set([".DS_Store", "__pycache__", ".pytest_cache", ".mypy_cache", ".cache"]);
const maximumInstallFiles = DEFAULT_SKILL_MAX_FILES;
const maximumInstallFileBytes = DEFAULT_SKILL_MAX_FILE_BYTES;
const maximumInstallBytes = DEFAULT_SKILL_MAX_BYTES;

export class SkillCatalog {
  readonly workspaceRoot: string;
  readonly workspaceSkillsRoot: string;
  readonly userSkillsRoot: string;
  readonly workspaceAgentSkillsRoot: string | undefined;
  readonly userAgentSkillsRoot: string | undefined;
  readonly userAgentLockPath: string | undefined;
  readonly agentActivationPath: string | undefined;
  readonly compatibilityRoots: readonly string[];
  readonly #loader: SkillLoader;

  constructor(options: SkillCatalogOptions) {
    const userHome = resolve(options.userHome ?? homedir());
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.workspaceSkillsRoot = resolve(this.workspaceRoot, ".qi", "skills");
    this.userSkillsRoot = resolve(options.userSkillsRoot ?? resolve(userHome, ".qi", "resources", "skills"));
    const agentSkillsEnabled = options.agentSkillsEnabled ?? true;
    this.userAgentSkillsRoot = agentSkillsEnabled
      ? resolve(options.userAgentSkillsRoot ?? resolve(userHome, ".agents", "skills"))
      : undefined;
    const workspaceAgentSkillsRoot = agentSkillsEnabled
      ? resolve(options.workspaceAgentSkillsRoot ?? resolve(this.workspaceRoot, ".agents", "skills"))
      : undefined;
    // If Qi is launched with the user's home directory as the Workspace, its .agents
    // directory is still the global Agent installation. Do not silently turn that
    // global source into a directly active Workspace root.
    this.workspaceAgentSkillsRoot = workspaceAgentSkillsRoot &&
      (this.userAgentSkillsRoot === undefined || !samePath(workspaceAgentSkillsRoot, this.userAgentSkillsRoot))
      ? workspaceAgentSkillsRoot
      : undefined;
    this.userAgentLockPath = agentSkillsEnabled
      ? resolve(options.userAgentLockPath ?? resolve(userHome, ".agents", ".skill-lock.json"))
      : undefined;
    this.agentActivationPath = agentSkillsEnabled
      ? resolve(options.agentActivationPath ?? resolve(userHome, ".qi", "resources", "skills.activation.json"))
      : undefined;
    this.compatibilityRoots = Object.freeze((options.compatibilityRoots ?? []).map((root) => resolve(root)));
    this.#loader = options.loader ?? new SkillLoader();
  }

  async discover(): Promise<CatalogSkill[]> {
    // Global Agent Skill installation is mutable outside Qi (for example, `npx skills remove -g`).
    // Reconcile the human activation record before exposing the catalog so a removed or lock-drifted
    // Skill is both unusable and no longer left behind as stale local state.
    await this.#reconcileAgentSkillActivations();
    // Lowest to highest precedence: global Agent, user Qi, project Agent, project Qi.
    const userAgent = await this.#discoverActivatedAgentScope();
    const user = await this.#discoverScope(this.userSkillsRoot, "user", "qi");
    const workspaceAgent = await this.#discoverAgentScope(this.workspaceAgentSkillsRoot, "workspace");
    const workspace = await this.#discoverScope(this.workspaceSkillsRoot, "workspace", "qi");
    const active = new Map<string, CatalogSkill>();
    for (const skill of [...userAgent, ...user, ...workspaceAgent, ...workspace]) {
      const shadowed = active.get(skill.name);
      active.set(skill.name, shadowed?.scope === "user" && skill.scope === "workspace"
        ? { ...skill, shadowedUserRoot: shadowed.root }
        : skill);
    }
    return [...active.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Read only validated frontmatter from generic Agent Skill roots.
   * Compatibility entries are intentionally separate from the active catalog: callers may present them to a
   * human as migration candidates, but `load`, `readResource`, and `run-script` can only select active entries.
   */
  async discoverCompatibility(activeSkills?: readonly CatalogSkill[]): Promise<CompatibilitySkill[]> {
    const activeNames = new Set((activeSkills ?? await this.discover()).map((skill) => skill.name));
    const found = new Map<string, CompatibilitySkill>();
    for (const root of this.compatibilityRoots) {
      for (const candidateRoot of [root, resolve(root, ".system")]) {
        let summaries: SkillSummary[];
        try {
          summaries = await this.#discoverCompatibilityRoot(candidateRoot);
        } catch {
          // Generic Agent directories are optional and untrusted. A malformed candidate must not prevent Qi startup.
          continue;
        }
        for (const summary of summaries) {
          if (activeNames.has(summary.name) || found.has(summary.name)) continue;
          found.set(summary.name, { ...summary, source: "compatibility" });
        }
      }
    }
    return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Read global .agents lock entries and expose only inactive Skills as activation candidates. */
  async discoverAgentCandidates(activeSkills?: readonly CatalogSkill[]): Promise<AgentSkillCandidate[]> {
    const activeNames = new Set((activeSkills ?? await this.discover()).map((skill) => skill.name));
    if (!this.userAgentSkillsRoot || !this.userAgentLockPath || !this.agentActivationPath) return [];
    const lock = await readAgentSkillLock(this.userAgentLockPath);
    const activations = await readAgentSkillActivations(this.agentActivationPath);
    const candidates: AgentSkillCandidate[] = [];
    for (const [name, entry] of Object.entries(lock)) {
      if (activeNames.has(name)) continue;
      const lockHash = agentSkillLockHash(entry);
      if (activations[name]?.lockHash === lockHash) continue;
      const root = await this.#agentLockEntryRoot(name, entry);
      if (!root) continue;
      try {
        const summary = await this.#loader.inspect(root);
        if (summary.name !== name) continue;
        candidates.push({
          ...summary,
          source: "global-agent",
          lockHash,
          activationPath: this.agentActivationPath,
        });
      } catch {
        // Malformed or stale third-party entries are omitted from the candidate view.
      }
    }
    return candidates.sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Activate one lock-listed global Agent Skill without copying or modifying its source directory. */
  async activateAgentSkill(name: string): Promise<AgentSkillCandidate | CatalogSkill> {
    if (!SKILL_NAME_PATTERN.test(name)) throw new TypeError(`Invalid Skill name: ${name}`);
    if (!this.userAgentLockPath || !this.agentActivationPath) throw new Error("Global Agent Skill activation is disabled");
    const lock = await readAgentSkillLock(this.userAgentLockPath);
    const entry = lock[name];
    if (!entry) throw new Error(`Global Agent Skill ${name} is not listed in .skill-lock.json`);
    const root = await this.#agentLockEntryRoot(name, entry);
    if (!root) throw new Error(`Global Agent Skill ${name} has an unsafe lock path`);
    const summary = await this.#loader.inspect(root);
    if (summary.name !== name) throw new Error(`Global Agent Skill ${name} metadata does not match its lock entry`);
    const active = { ...(await readAgentSkillActivations(this.agentActivationPath)) };
    active[name] = { lockHash: agentSkillLockHash(entry), activatedAt: new Date().toISOString() };
    await writeAgentSkillActivations(this.agentActivationPath, active);
    return { ...summary, scope: "user", origin: "agent" };
  }

  async deactivateAgentSkill(name: string): Promise<boolean> {
    if (!this.agentActivationPath) return false;
    const active = { ...(await readAgentSkillActivations(this.agentActivationPath)) };
    if (!active[name]) return false;
    delete active[name];
    await writeAgentSkillActivations(this.agentActivationPath, active);
    return true;
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

  /** Content-address the active Skill tree for immutable Run provenance. */
  async digest(name: string): Promise<string> {
    const skill = await this.#select(name);
    return digestInstallFiles(await collectInstallFiles(skill.root));
  }

  /**
   * Lists Qi-managed Skills that human operators may remove: copies under
   * `$QI_HOME/resources/skills` and `<workspace>/.qi/skills`. Agent / global
   * `.agents` Skills are never included.
   */
  async listManagedSkills(): Promise<readonly CatalogSkill[]> {
    const user = await this.#discoverScope(this.userSkillsRoot, "user", "qi");
    const workspace = await this.#discoverScope(this.workspaceSkillsRoot, "workspace", "qi");
    return Object.freeze(
      [...workspace, ...user].sort((left, right) =>
        left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope)),
    );
  }

  /**
   * Human-operated removal of a Qi-managed Skill tree. Only deletes directories
   * under the user or Workspace Qi roots and drops the matching lock entry.
   * Agent roots, symbolic links, and non-directory targets are rejected.
   */
  async remove(name: string, options: { scope?: SkillScope } = {}): Promise<CatalogSkill> {
    if (!skillNamePattern.test(name)) throw new TypeError(`Invalid Skill name: ${name}`);
    const scope = options.scope ?? (await this.#resolveManagedScope(name));
    const skillsRoot = scope === "workspace" ? this.workspaceSkillsRoot : this.userSkillsRoot;
    const parent = await this.#managedSkillsRoot(skillsRoot, scope);
    const target = resolve(parent, name);
    assertContained(parent, target, "Skill");
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isMissing(error)) throw new Error(`Skill ${name} is not installed in ${scope} scope`);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Skill ${name} must be a real directory under the ${scope} Qi root`);
    }
    const summary = await this.#loader.inspect(await realpath(target));
    if (summary.name !== name) {
      throw new Error(`Skill directory ${name} declares metadata name ${summary.name}; refusing remove`);
    }
    await rm(target, { recursive: true, force: false });
    await removeSkillLockEntry(skillsRoot, name);
    return Object.freeze({ ...summary, scope, origin: "qi" as const });
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
      const digest = await digestInstallFiles(files);
      await copyInstallFiles(files, temporary);
      const staged = await this.#loader.load(temporary);
      if (staged.name !== source.name || staged.description !== source.description) {
        throw new Error("Installed Skill metadata does not match its source");
      }
      await rename(temporary, target);
      const localSource = {
        type: "local" as const,
        resolved: portableLocalSource(scope, this.workspaceRoot, sourceRoot),
        subdir: ".",
      };
      await writeSkillLock(scope === "workspace" ? this.workspaceSkillsRoot : this.userSkillsRoot, staged, digest, localSource);
      return {
        ...staged,
        root: target,
        scope,
        origin: "qi",
        sourceRoot,
        digest,
        source: localSource,
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Human-operated immutable acquisition. This method is intentionally not exposed by the model Skill Tool. */
  async installImmutable(
    source: ImmutableSkillSource,
    options: { scope?: SkillScope; expectedName?: string } = {},
  ): Promise<InstalledSkill> {
    const acquired = await acquireImmutableSkillSource(source);
    try {
      const installed = await this.install({
        source: acquired.root,
        scope: options.scope ?? "user",
        ...(options.expectedName === undefined ? {} : { expectedName: options.expectedName }),
      });
      await writeSkillLock(
        installed.scope === "workspace" ? this.workspaceSkillsRoot : this.userSkillsRoot,
        installed,
        installed.digest,
        acquired.provenance,
      );
      return { ...installed, source: acquired.provenance };
    } finally {
      // Windows can retain a Git pack handle for a short period after checkout. The source
      // acquisition retries cleanup; a final EBUSY must not turn an already-published Skill into
      // a failed install (the staging directory is isolated and can be reclaimed later).
      await acquired.cleanup().catch(() => undefined);
    }
  }

  /** Human-operated `npx skills add <github-url> --skill <name>` convenience path. */
  async installGithubSkill(
    url: string,
    name: string,
    options: { scope?: SkillScope; subdir?: string } = {},
  ): Promise<InstalledSkill> {
    if (!skillNamePattern.test(name)) throw new TypeError(`Invalid Skill name: ${name}`);
    const resolved = await resolveGithubSkillSource(url, name, {
      ...(options.subdir === undefined ? {} : { subdir: options.subdir }),
    });
    return this.installImmutable(resolved.source, {
      scope: options.scope ?? "user",
      expectedName: resolved.skill,
    });
  }

  async exportWorkspaceDraft(name: string, destination: string): Promise<ExportedWorkspaceSkillDraft> {
    const sourceRoot = await this.#workspaceSkillRoot(name);
    const source = await this.#loader.load(sourceRoot);
    assertSkillDirectoryName(source.name, sourceRoot.split(/[\\/]/).at(-1)!);
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
      const localSource = {
        type: "local" as const,
        resolved: portableLocalSource("workspace", this.workspaceRoot, sourceRoot),
        subdir: ".",
      };
      await writeSkillLock(this.workspaceSkillsRoot, published, publishedDigest, localSource);
      return {
        ...published,
        root: target,
        scope: "workspace",
        origin: "qi",
        sourceRoot,
        source: localSource,
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

  async #resolveManagedScope(name: string): Promise<SkillScope> {
    const managed = await this.listManagedSkills();
    const matches = managed.filter((skill) => skill.name === name);
    if (matches.length === 0) throw new Error(`Skill ${name} is not installed under a Qi-managed root`);
    if (matches.length > 1) {
      throw new Error(
        `Skill ${name} exists in both user and workspace scopes; pass --scope user|workspace`,
      );
    }
    return matches[0]!.scope;
  }

  async #managedSkillsRoot(skillsRoot: string, scope: SkillScope): Promise<string> {
    let info;
    try {
      info = await lstat(skillsRoot);
    } catch (error) {
      if (isMissing(error)) throw new Error(`No Skills are installed in ${scope} scope`);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${scope} Skill root must be a real directory: ${skillsRoot}`);
    }
    return realpath(skillsRoot);
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

  async #discoverScope(root: string, scope: SkillScope, origin: SkillOrigin): Promise<CatalogSkill[]> {
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
      return { ...summary, scope, origin };
    });
  }

  async #discoverAgentScope(root: string | undefined, scope: SkillScope): Promise<CatalogSkill[]> {
    if (!root) return [];
    try {
      const summaries = await this.#discoverCompatibilityRoot(root);
      const names = new Set<string>();
      return summaries.map((summary) => {
        if (!skillNamePattern.test(summary.name)) throw new TypeError(`Invalid Skill name in ${root}: ${summary.name}`);
        if (names.has(summary.name)) throw new Error(`Duplicate Skill name in ${root}: ${summary.name}`);
        names.add(summary.name);
        return { ...summary, scope, origin: "agent" as const };
      });
    } catch {
      // Optional third-party roots are untrusted. Invalid metadata is omitted without blocking Qi startup.
      return [];
    }
  }

  async #discoverActivatedAgentScope(): Promise<CatalogSkill[]> {
    if (!this.userAgentSkillsRoot || !this.userAgentLockPath || !this.agentActivationPath) return [];
    const lock = await readAgentSkillLock(this.userAgentLockPath);
    const activations = await readAgentSkillActivations(this.agentActivationPath);
    const active: CatalogSkill[] = [];
    for (const [name, entry] of Object.entries(lock)) {
      if (activations[name]?.lockHash !== agentSkillLockHash(entry)) continue;
      const root = await this.#agentLockEntryRoot(name, entry);
      if (!root) continue;
      try {
        const summary = await this.#loader.inspect(root);
        if (summary.name === name) active.push({ ...summary, scope: "user", origin: "agent" });
      } catch {
        // Drifted or malformed global entries remain inactive until explicitly repaired and reactivated.
      }
    }
    return active.sort((left, right) => left.name.localeCompare(right.name));
  }

  async #reconcileAgentSkillActivations(): Promise<void> {
    if (!this.userAgentLockPath || !this.agentActivationPath) return;
    const lock = await readAgentSkillLock(this.userAgentLockPath);
    const current = await readAgentSkillActivations(this.agentActivationPath);
    const reconciled = Object.fromEntries(
      Object.entries(current).filter(([name, activation]) => {
        const entry = lock[name];
        return entry !== undefined && activation.lockHash === agentSkillLockHash(entry);
      }),
    );
    if (Object.keys(reconciled).length === Object.keys(current).length) return;
    await writeAgentSkillActivations(this.agentActivationPath, reconciled);
  }

  async #agentLockEntryRoot(name: string, entry: AgentSkillLockEntry): Promise<string | undefined> {
    if (!this.userAgentSkillsRoot || typeof entry.skillPath !== "string") return undefined;
    const directRoot = resolve(this.userAgentSkillsRoot, name);
    if (await exists(directRoot)) return directRoot;
    const lockRoot = dirname(this.userAgentSkillsRoot);
    const root = resolve(lockRoot, dirname(entry.skillPath.replaceAll("\\", "/")));
    const relativeRoot = relative(this.userAgentSkillsRoot, root);
    if (relativeRoot === "" || relativeRoot === "." || relativeRoot.startsWith("..") || isAbsolute(relativeRoot)) return undefined;
    return root;
  }

  async #discoverCompatibilityRoot(root: string): Promise<SkillSummary[]> {
    let info;
    try {
      info = await lstat(root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
    return this.#loader.discover(await realpath(root));
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
  await walkOptional(root, root, files);
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
    if (path === root && entry.name.startsWith(".")) {
      if (entry.isDirectory()) throw new Error(`Skill install refuses hidden management directory ${entry.name}`);
    }
    if (rejectedDirectoryNames.has(entry.name)) throw new Error(`Skill install refuses package/VCS directory ${entry.name}`);
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

function portableLocalSource(scope: SkillScope, workspaceRoot: string, sourceRoot: string): string {
  if (scope !== "workspace") return "<local>";
  const candidate = relative(workspaceRoot, sourceRoot).replaceAll("\\", "/");
  return candidate && !candidate.startsWith("..") ? candidate : "<external-local>";
}

async function writeSkillLock(
  skillsRoot: string,
  skill: Pick<SkillSummary, "name" | "version" | "license">,
  digest: string,
  source: SkillSourceProvenance | { type: "local"; resolved: string; subdir: string },
): Promise<void> {
  const lockPath = skillLockPath(skillsRoot);
  let current: { schemaVersion: 1; skills: Record<string, unknown> } = { schemaVersion: 1, skills: {} };
  try {
    current = JSON.parse(await readFile(lockPath, "utf8")) as typeof current;
    if (current.schemaVersion !== 1 || typeof current.skills !== "object" || current.skills === null) {
      throw new TypeError(`Invalid Skill lock: ${lockPath}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  current.skills[skill.name] = {
    version: skill.version,
    digest,
    ...(skill.license === undefined ? {} : { license: skill.license }),
    source,
  };
  await mkdir(dirname(lockPath), { recursive: true });
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, lockPath);
}

async function removeSkillLockEntry(skillsRoot: string, name: string): Promise<void> {
  const lockPath = skillLockPath(skillsRoot);
  let current: { schemaVersion: 1; skills: Record<string, unknown> };
  try {
    current = JSON.parse(await readFile(lockPath, "utf8")) as typeof current;
    if (current.schemaVersion !== 1 || typeof current.skills !== "object" || current.skills === null) {
      throw new TypeError(`Invalid Skill lock: ${lockPath}`);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!(name in current.skills)) return;
  delete current.skills[name];
  await mkdir(dirname(lockPath), { recursive: true });
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, lockPath);
}

function skillLockPath(skillsRoot: string): string {
  return resolve(dirname(skillsRoot), "skills.lock.json");
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
