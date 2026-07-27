import { mkdir, readFile, writeFile, lstat, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  resolveCapabilities,
  type CapabilityOverrides,
  type QiCapabilityConfig,
  type QiShellConfig,
  type QiUserConfig,
  type ResolvedCapabilities,
} from "./config.js";
import { defaultProjectConfigPath } from "./paths.js";

const projectConfigLimitBytes = 64 * 1024;
const mountIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface ProjectMountConfig {
  readonly id: string;
  readonly path: string;
  readonly mode: "read";
}

export interface QiProjectConfig {
  readonly version: 1;
  readonly maxSteps?: number;
  readonly capabilities?: QiCapabilityConfig;
  readonly shell?: QiShellConfig;
  readonly mounts?: readonly ProjectMountConfig[];
}

export interface LoadedProjectConfig {
  readonly path: string;
  readonly exists: boolean;
  readonly config: QiProjectConfig;
}

export async function loadProjectConfig(path: string): Promise<LoadedProjectConfig> {
  const absolute = resolve(path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TypeError(`Project config must be a regular, non-symlink file: ${absolute}`);
    }
    if (info.size > projectConfigLimitBytes) {
      throw new TypeError(`Project config exceeds ${projectConfigLimitBytes} bytes: ${absolute}`);
    }
    const decoded = parse((await readFile(absolute, "utf8")).replace(/^\uFEFF/, ""));
    return { path: absolute, exists: true, config: validateProjectConfig(decoded, absolute) };
  } catch (error) {
    if (isMissing(error)) return { path: absolute, exists: false, config: { version: 1 } };
    throw error;
  }
}

export async function saveProjectConfig(path: string, config: QiProjectConfig): Promise<void> {
  const absolute = resolve(path);
  validateProjectConfig(config, absolute);
  await mkdir(dirname(absolute), { recursive: true });
  const body = stringify({
    version: 1,
    ...(config.maxSteps === undefined ? {} : { max_steps: config.maxSteps }),
    ...(config.capabilities === undefined ? {} : { capabilities: { ...config.capabilities } }),
    ...(config.shell === undefined ? {} : { shell: { ...config.shell, ...(config.shell.allowed ? { allowed: [...config.shell.allowed] } : {}) } }),
    ...(config.mounts === undefined || config.mounts.length === 0
      ? {}
      : { mounts: config.mounts.map((mount) => ({ id: mount.id, path: mount.path, mode: mount.mode })) }),
  });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${body}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function mergeCapabilities(
  globalCaps: QiCapabilityConfig | undefined,
  projectCaps: QiCapabilityConfig | undefined,
  overrides: CapabilityOverrides = {},
): ResolvedCapabilities {
  const configured: QiCapabilityConfig = {
    ...(pickBoolean(projectCaps?.write ?? globalCaps?.write, "write")),
    ...(pickBoolean(projectCaps?.verify ?? globalCaps?.verify, "verify")),
    ...(pickBoolean(projectCaps?.network ?? globalCaps?.network, "network")),
    ...(pickBoolean(projectCaps?.execute ?? globalCaps?.execute, "execute")),
    ...(pickBoolean(projectCaps?.background ?? globalCaps?.background, "background")),
    ...(pickBoolean(projectCaps?.delegate ?? globalCaps?.delegate, "delegate")),
  };
  return resolveCapabilities(configured, overrides);
}

export function mergeShell(
  globalShell: QiShellConfig | undefined,
  projectShell: QiShellConfig | undefined,
): QiShellConfig | undefined {
  if (!globalShell && !projectShell) return undefined;
  const defaultProfile = projectShell?.default ?? globalShell?.default;
  const allowed = projectShell?.allowed ?? globalShell?.allowed;
  return {
    ...(defaultProfile === undefined ? {} : { default: defaultProfile }),
    ...(allowed === undefined ? {} : { allowed }),
  };
}

export function suggestMountId(absolutePath: string, existing: ReadonlySet<string>): string {
  const base = absolutePath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    ?? "mount";
  let id = base.slice(0, 48) || "mount";
  if (!/^[a-z]/.test(id)) id = `m-${id}`.slice(0, 48);
  if (!existing.has(id) && mountIdPattern.test(id)) return id;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${id.slice(0, 40)}-${index}`;
    if (!existing.has(candidate) && mountIdPattern.test(candidate)) return candidate;
  }
  throw new TypeError("Could not allocate a mount id");
}

export function assertMountPathAllowed(absolutePath: string): void {
  const normalized = absolutePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/?$/.test(normalized) || normalized === "/") {
    throw new TypeError("Refusing to mount a drive or filesystem root");
  }
}

export function projectConfigPathForWorkspace(
  workspaceRoot: string,
  environment?: Readonly<Record<string, string | undefined>>,
): string {
  return defaultProjectConfigPath(workspaceRoot, environment);
}

function validateProjectConfig(value: unknown, path: string): QiProjectConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: root must be a table`);
  }
  const root = value as Record<string, unknown>;
  if (root.version !== 1) throw new TypeError(`${path}: version must be 1`);
  const maxSteps = validateMaxSteps(root.max_steps, path);
  const capabilities = root.capabilities === undefined
    ? undefined
    : validateCapabilities(root.capabilities, path);
  const shell = root.shell === undefined ? undefined : validateShell(root.shell, path);
  const mounts = root.mounts === undefined ? undefined : validateMounts(root.mounts, path);
  return {
    version: 1,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(shell === undefined ? {} : { shell }),
    ...(mounts === undefined ? {} : { mounts }),
  };
}

function validateMaxSteps(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 8 || (value as number) > 100) {
    throw new TypeError(`${path}: max_steps must be an integer from 8 to 100`);
  }
  return value as number;
}

function validateCapabilities(value: unknown, path: string): QiCapabilityConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: capabilities must be a table`);
  }
  const table = value as Record<string, unknown>;
  const out: QiCapabilityConfig = {};
  for (const key of ["write", "verify", "network", "execute", "background", "delegate"] as const) {
    if (table[key] === undefined) continue;
    if (typeof table[key] !== "boolean") throw new TypeError(`${path}: capabilities.${key} must be boolean`);
    (out as Record<string, boolean>)[key] = table[key] as boolean;
  }
  return out;
}

function validateShell(value: unknown, path: string): QiShellConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: shell must be a table`);
  }
  const table = value as Record<string, unknown>;
  const allowedIds = new Set(["direct", "pwsh", "cmd", "bash"]);
  let defaultProfile: QiShellConfig["default"];
  let allowed: QiShellConfig["allowed"];
  if (table.default !== undefined) {
    if (typeof table.default !== "string" || !allowedIds.has(table.default)) {
      throw new TypeError(`${path}: shell.default is invalid`);
    }
    defaultProfile = table.default as QiShellConfig["default"];
  }
  if (table.allowed !== undefined) {
    if (!Array.isArray(table.allowed) || !table.allowed.every((item) => typeof item === "string" && allowedIds.has(item))) {
      throw new TypeError(`${path}: shell.allowed is invalid`);
    }
    allowed = table.allowed as QiShellConfig["allowed"];
  }
  return {
    ...(defaultProfile === undefined ? {} : { default: defaultProfile }),
    ...(allowed === undefined ? {} : { allowed }),
  };
}

function pickBoolean(
  value: boolean | undefined,
  key: keyof QiCapabilityConfig,
): Partial<QiCapabilityConfig> {
  return value === undefined ? {} : { [key]: value };
}

function validateMounts(value: unknown, path: string): ProjectMountConfig[] {
  if (!Array.isArray(value)) throw new TypeError(`${path}: mounts must be an array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${path}: mounts[${index}] must be a table`);
    }
    const table = entry as Record<string, unknown>;
    if (typeof table.id !== "string" || !mountIdPattern.test(table.id)) {
      throw new TypeError(`${path}: mounts[${index}].id is invalid`);
    }
    if (seen.has(table.id)) throw new TypeError(`${path}: duplicate mount id ${table.id}`);
    seen.add(table.id);
    if (typeof table.path !== "string" || !table.path.trim()) {
      throw new TypeError(`${path}: mounts[${index}].path is required`);
    }
    if (table.mode !== "read") throw new TypeError(`${path}: mounts[${index}].mode must be \"read\"`);
    return { id: table.id, path: resolve(table.path), mode: "read" as const };
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Re-export for callers that already hold a global user config shape. */
export type { QiUserConfig };
