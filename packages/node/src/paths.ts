import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

export const QI_LAYOUT_GENERATION = 2;
export const QI_LAYOUT_VERSION = "0.6";
export const QI_PROJECT_LAYOUT_VERSION = 2;

export interface QiLayoutFile {
  readonly generation: typeof QI_LAYOUT_GENERATION;
  readonly version: typeof QI_LAYOUT_VERSION;
}

export interface QiEnvironment {
  readonly QI_HOME?: string;
}

export interface ProjectPaths {
  readonly qiHome: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly root: string;
  readonly projectFile: string;
  readonly policyFile: string;
  readonly sessionsRoot: string;
  readonly archivesRoot: string;
  readonly stateRoot: string;
  readonly memoryFile: string;
  readonly schedulerFile: string;
  readonly packagesRoot: string;
  readonly activationFile: string;
  readonly cacheRoot: string;
  readonly temporaryRoot: string;
}

export interface ProjectSessionPaths {
  readonly sessionId: string;
  readonly location: "active" | "archived";
  readonly root: string;
  readonly stateRoot: string;
  readonly databaseFile: string;
  readonly effectsFile: string;
  readonly artifactsRoot: string;
  readonly plansRoot: string;
  readonly tasksRoot: string;
  readonly archiveManifestFile: string;
}

export interface QiStatePaths {
  readonly stateRoot: string;
  readonly continuityDatabaseFile: string;
  readonly memoryFile: string;
}

export function qiStatePaths(qiHome: string): QiStatePaths {
  const stateRoot = resolve(qiHome, "state");
  return {
    stateRoot,
    continuityDatabaseFile: resolve(stateRoot, "continuity.sqlite"),
    memoryFile: resolve(stateRoot, "memory.sqlite"),
  };
}

export function defaultQiHome(
  environment: QiEnvironment = process.env,
  homeDirectory = homedir(),
): string {
  const configured = environment.QI_HOME?.trim();
  return resolve(configured || resolve(homeDirectory, ".qi"));
}

export function defaultProjectsRoot(
  environment: QiEnvironment = process.env,
  homeDirectory = homedir(),
): string {
  return resolve(defaultQiHome(environment, homeDirectory), "projects");
}

export function canonicalWorkspacePath(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim();
  if (!trimmed) throw new TypeError("Workspace path must not be empty");
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const windowsPath = win32.normalize(trimmed).replace(/\\/g, "/");
    if (process.platform !== "win32" || !existsSync(trimmed)) return windowsPath;
  }
  if (trimmed.startsWith("\\\\")) {
    const uncPath = win32.normalize(trimmed).replace(/\\/g, "/");
    if (process.platform !== "win32" || !existsSync(trimmed)) return uncPath;
  }
  if (trimmed.startsWith("/") && process.platform === "win32") {
    return posix.normalize(trimmed).replace(/\/+$/g, "");
  }
  const absolute = resolve(trimmed);
  const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  return normalizeForIdentity(canonical);
}

export function workspaceProjectId(workspaceRoot: string): string {
  const canonical = canonicalWorkspacePath(workspaceRoot);
  const readable = sanitizeProjectName(basename(canonical) || "workspace");
  const digest = createHash("sha256").update(identityCase(canonical)).digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

export function defaultSessionDataRoot(
  workspaceRoot: string,
  environment: QiEnvironment = process.env,
  homeDirectory = homedir(),
): string {
  return resolve(defaultProjectsRoot(environment, homeDirectory), workspaceProjectId(workspaceRoot));
}

export function defaultProjectConfigPath(
  workspaceRoot: string,
  environment: QiEnvironment = process.env,
  homeDirectory = homedir(),
): string {
  return resolve(defaultSessionDataRoot(workspaceRoot, environment, homeDirectory), "policy.toml");
}

export function projectPaths(input: {
  readonly workspaceRoot: string;
  readonly dataRoot?: string;
  readonly environment?: QiEnvironment;
  readonly homeDirectory?: string;
}): ProjectPaths {
  const environment = input.environment ?? process.env;
  const homeDirectory = input.homeDirectory ?? homedir();
  const qiHome = defaultQiHome(environment, homeDirectory);
  const workspaceRoot = canonicalWorkspacePath(input.workspaceRoot);
  const projectId = workspaceProjectId(workspaceRoot);
  const root = resolve(input.dataRoot ?? resolve(qiHome, "projects", projectId));
  const stateRoot = resolve(root, "state");
  const packagesRoot = resolve(root, "packages");
  return {
    qiHome,
    workspaceRoot,
    projectId,
    root,
    projectFile: resolve(root, "project.json"),
    policyFile: resolve(root, "policy.toml"),
    sessionsRoot: resolve(root, "sessions"),
    archivesRoot: resolve(root, "archives"),
    stateRoot,
    memoryFile: resolve(stateRoot, "memory.sqlite"),
    schedulerFile: resolve(stateRoot, "scheduler.sqlite"),
    packagesRoot,
    activationFile: resolve(packagesRoot, "activation.json"),
    cacheRoot: resolve(root, "cache"),
    temporaryRoot: resolve(root, "tmp"),
  };
}

export function projectSessionPaths(
  paths: ProjectPaths,
  sessionId: string,
  location: "active" | "archived" = "active",
): ProjectSessionPaths {
  if (!/^ses_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(sessionId)) {
    throw new TypeError(`Invalid Session ID: ${sessionId}`);
  }
  const root = resolve(location === "active" ? paths.sessionsRoot : paths.archivesRoot, sessionId);
  const stateRoot = resolve(root, "state");
  return {
    sessionId,
    location,
    root,
    stateRoot,
    databaseFile: resolve(stateRoot, "qi.sqlite"),
    effectsFile: resolve(stateRoot, "effects.sqlite"),
    artifactsRoot: resolve(root, "artifacts"),
    plansRoot: resolve(root, "plans"),
    tasksRoot: resolve(root, "tasks"),
    archiveManifestFile: resolve(root, "archive.json"),
  };
}

export async function ensureProjectSessionLayout(paths: ProjectSessionPaths): Promise<void> {
  await Promise.all([
    paths.stateRoot,
    paths.artifactsRoot,
    paths.plansRoot,
    paths.tasksRoot,
  ].map((entry) => mkdir(entry, { recursive: true })));
}

export async function ensureQiLayout(
  qiHome: string,
  options: { readonly workspaceRoot?: string } = {},
): Promise<void> {
  const root = resolve(qiHome);
  await assertSafePrivateRoot(root, options.workspaceRoot);
  await assertLayoutGeneration(root);
  await mkdir(root, { recursive: true });
  const directories = [
    "state",
    "credentials",
    "resources/skills",
    "resources/prompts",
    "resources/themes",
    "resources/agents",
    "resources/workflows",
    "resources/mcp",
    "packages/store",
    "packages/cache/npm",
    "packages/cache/git",
    "packages/cache/catalog",
    "packages/staging",
    "plugins/marketplaces",
    "plugins/cache",
    "projects",
  ];
  await Promise.all(directories.map((entry) => mkdir(resolve(root, entry), { recursive: true })));
  const layout: QiLayoutFile = { generation: QI_LAYOUT_GENERATION, version: QI_LAYOUT_VERSION };
  await writeJsonAtomic(resolve(root, "layout.json"), layout);
  await Promise.all([
    ensureTextFile(resolve(root, "packages", "installed.toml"), "version = 1\n"),
    ensureTextFile(
      resolve(root, "packages", "lock.json"),
      `${JSON.stringify({ schemaVersion: 1, packages: {} }, null, 2)}\n`,
    ),
    ensureTextFile(
      resolve(root, "plugins", "known_marketplaces.json"),
      `${JSON.stringify({ schemaVersion: 1, marketplaces: {} }, null, 2)}\n`,
    ),
    ensureTextFile(
      resolve(root, "plugins", "enabled.json"),
      `${JSON.stringify({ schemaVersion: 2, plugins: {} }, null, 2)}\n`,
    ),
  ]);
}

export async function ensureProjectLayout(paths: ProjectPaths): Promise<void> {
  await ensureQiLayout(paths.qiHome, { workspaceRoot: paths.workspaceRoot });
  await assertSafePrivateRoot(paths.root, paths.workspaceRoot);
  await assertProjectLayout(paths);
  const directories = [
    paths.stateRoot,
    paths.sessionsRoot,
    paths.archivesRoot,
    paths.packagesRoot,
    paths.cacheRoot,
    paths.temporaryRoot,
  ];
  await Promise.all(directories.map((entry) => mkdir(entry, { recursive: true })));
  await writeJsonAtomic(paths.projectFile, {
    schemaVersion: QI_PROJECT_LAYOUT_VERSION,
    projectId: paths.projectId,
    workspaceRoot: paths.workspaceRoot,
    dataRoot: paths.root,
  });
  await ensureTextFile(
    paths.activationFile,
    `${JSON.stringify({ schemaVersion: 1, packages: {} }, null, 2)}\n`,
  );
}

async function assertProjectLayout(paths: ProjectPaths): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(paths.projectFile, "utf8")) as { schemaVersion?: unknown };
    if (parsed.schemaVersion !== QI_PROJECT_LAYOUT_VERSION) {
      throw legacyProjectLayoutError(paths.root, `project schema ${String(parsed.schemaVersion)}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const legacy = [
    resolve(paths.root, "state", "qi.sqlite"),
    resolve(paths.root, "artifacts"),
    resolve(paths.root, "plans"),
    resolve(paths.root, "tasks"),
  ].find((candidate) => existsSync(candidate));
  if (legacy) throw legacyProjectLayoutError(paths.root, `legacy path ${legacy}`);
}

function legacyProjectLayoutError(root: string, detail: string): Error {
  return new Error(
    `Qi project ${root} uses an unsupported shared Session layout (${detail}). ` +
    "Back it up and clear this project data directory, or start with a new --data path; Qi will not migrate or delete it.",
  );
}

export async function discoverProjects(
  qiHome: string,
): Promise<readonly ProjectPaths[]> {
  const projectsRoot = resolve(qiHome, "projects");
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const projects: ProjectPaths[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const projectFile = resolve(projectsRoot, entry.name, "project.json");
    try {
      const parsed = JSON.parse(await readFile(projectFile, "utf8")) as {
        workspaceRoot?: unknown;
        dataRoot?: unknown;
      };
      if (typeof parsed.workspaceRoot !== "string") continue;
      projects.push(projectPaths({
        workspaceRoot: parsed.workspaceRoot,
        dataRoot: typeof parsed.dataRoot === "string"
          ? parsed.dataRoot
          : resolve(projectsRoot, entry.name),
        environment: { QI_HOME: qiHome },
      }));
    } catch {
      // A malformed project descriptor is not a discoverable project.
    }
  }
  return projects;
}

export async function assertSafePrivateRoot(
  privateRoot: string,
  workspaceRoot?: string,
): Promise<void> {
  const root = resolve(privateRoot);
  if (isFilesystemRoot(root)) throw new Error(`Qi private root must not be a filesystem root: ${root}`);
  if (workspaceRoot && (
    isWithin(resolve(workspaceRoot), root) ||
    isWithin(root, resolve(workspaceRoot))
  )) {
    throw new Error(`Qi private root and Workspace must not contain one another: ${root}`);
  }
  await rejectSymlinkChain(root);
}

/**
 * Files Qi may write under $QI_HOME before layout.json exists (first-run bootstrap).
 * A home containing only these is not treated as a pre-0.6 install.
 */
const QI_HOME_BOOTSTRAP_ONLY_ENTRIES = new Set([
  "config.toml",
]);

async function assertLayoutGeneration(root: string): Promise<void> {
  const layoutPath = resolve(root, "layout.json");
  try {
    const layout = JSON.parse(await readFile(layoutPath, "utf8")) as {
      generation?: unknown;
    };
    if (layout.generation !== QI_LAYOUT_GENERATION) {
      throw legacyLayoutError(root, `layout generation ${String(layout.generation)}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existsSync(root)) return;
  const entries = await readdir(root);
  const foreign = entries.filter((entry) => !QI_HOME_BOOTSTRAP_ONLY_ENTRIES.has(entry));
  if (foreign.length > 0) throw legacyLayoutError(root, "layout.json is missing");
}

function legacyLayoutError(root: string, detail: string): Error {
  return new Error(
    `QI_HOME ${root} uses an unsupported pre-0.6 layout (${detail}). ` +
    "Back it up and clear it, or set QI_HOME to a new empty directory; Qi will not migrate or delete it.",
  );
}

async function rejectSymlinkChain(target: string): Promise<void> {
  const missing: string[] = [];
  let cursor = target;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existsSync(cursor)) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Qi managed paths must not be symbolic links: ${cursor}`);
    const canonical = await realpath(cursor);
    if (identityCase(normalizeForIdentity(canonical)) !== identityCase(normalizeForIdentity(cursor))) {
      throw new Error(`Qi managed paths must not traverse symlinks or junctions: ${cursor}`);
    }
  }
  for (const candidate of missing.reverse()) {
    const parent = dirname(candidate);
    if (!isWithin(parent, candidate)) throw new Error(`Invalid managed path: ${candidate}`);
  }
}

function isFilesystemRoot(candidate: string): boolean {
  const parsed = parse(resolve(candidate));
  return resolve(candidate) === resolve(parsed.root);
}

function isWithin(parent: string, child: string): boolean {
  const result = relative(resolve(parent), resolve(child));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function sanitizeProjectName(value: string): string {
  const sanitized = value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return (sanitized || "workspace").slice(0, 64);
}

function normalizeForIdentity(value: string): string {
  const absolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/")
    ? value
    : resolve(value);
  return absolute.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function identityCase(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (await readFile(path, "utf8") === serialized) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await rm(temporary, { force: true });
  await writeFile(temporary, serialized, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

async function ensureTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
