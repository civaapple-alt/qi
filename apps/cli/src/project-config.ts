import { mkdir, readFile, writeFile, lstat, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  resolveCapabilities,
  type CapabilityOverrides,
  type QiCapabilityConfig,
  type QiPermissionMode,
  type QiSandboxConfig,
  type QiShellConfig,
  type QiUserConfig,
  type ResolvedCapabilities,
} from "./config.js";
import {
  leasePackForPermissionMode,
  parseApprovalPattern,
  serializeApprovalPattern,
  type PermissionMode,
  type StoredApproval,
} from "@civaapple/qi-agent/capability";
import { defaultProjectConfigPath } from "./paths.js";

const projectConfigLimitBytes = 64 * 1024;
const mountIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface ProjectMountConfig {
  readonly id: string;
  readonly path: string;
  readonly mode: "read";
}

export interface ProjectSensitivePathPolicy {
  readonly extra?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface QiProjectPermissionConfig {
  readonly mode?: QiPermissionMode;
}

export interface QiProjectApprovalRecord {
  readonly pattern: string;
  readonly decision: "allow" | "deny";
  readonly createdAt: string;
  readonly source?: string;
}

export interface QiProjectConfig {
  readonly version: 1;
  readonly maxSteps?: number;
  /** ADR-0040 primary control. */
  readonly permission?: QiProjectPermissionConfig;
  readonly sandbox?: QiSandboxConfig;
  readonly capabilities?: QiCapabilityConfig;
  readonly shell?: QiShellConfig;
  readonly mounts?: readonly ProjectMountConfig[];
  /** Manual approval memory (ADR-0040 [[approvals]]). */
  readonly approvals?: readonly QiProjectApprovalRecord[];
  /** Workspace-relative paths whose file bodies may reach the model. */
  readonly sensitivePathGrants?: readonly string[];
  /** Optional overlays for default sensitive-path classification. */
  readonly sensitivePaths?: ProjectSensitivePathPolicy;
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
    ...(config.permission === undefined
      ? {}
      : {
          permission: {
            ...(config.permission.mode === undefined ? {} : { mode: config.permission.mode }),
          },
        }),
    ...(config.sandbox === undefined
      ? {}
      : {
          sandbox: {
            ...(config.sandbox.policy === undefined ? {} : { policy: config.sandbox.policy }),
          },
        }),
    ...(config.capabilities === undefined ? {} : { capabilities: { ...config.capabilities } }),
    ...(config.shell === undefined ? {} : { shell: { ...config.shell, ...(config.shell.allowed ? { allowed: [...config.shell.allowed] } : {}) } }),
    ...(config.mounts === undefined || config.mounts.length === 0
      ? {}
      : { mounts: config.mounts.map((mount) => ({ id: mount.id, path: mount.path, mode: mount.mode })) }),
    ...(config.approvals === undefined || config.approvals.length === 0
      ? {}
      : {
          approvals: config.approvals.map((entry) => ({
            pattern: entry.pattern,
            decision: entry.decision,
            created_at: entry.createdAt,
            ...(entry.source === undefined ? {} : { source: entry.source }),
          })),
        }),
    ...(config.sensitivePathGrants === undefined || config.sensitivePathGrants.length === 0
      ? {}
      : { sensitive_path_grants: [...config.sensitivePathGrants] }),
    ...(config.sensitivePaths === undefined
      ? {}
      : {
        sensitive_paths: {
          ...(config.sensitivePaths.extra === undefined ? {} : { extra: [...config.sensitivePaths.extra] }),
          ...(config.sensitivePaths.exclude === undefined ? {} : { exclude: [...config.sensitivePaths.exclude] }),
        },
      }),
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
  options: {
    readonly permissionMode?: PermissionMode;
  } = {},
): ResolvedCapabilities {
  // When permission mode is set and neither layer has explicit capability keys, expand the coding pack.
  const hasExplicitCaps = hasAnyCapabilityKey(globalCaps) || hasAnyCapabilityKey(projectCaps);
  const fromPermission =
    !hasExplicitCaps && options.permissionMode !== undefined
      ? capabilityConfigFromPermissionMode(
        options.permissionMode,
        overrides.safe === true ? { safe: true } : {},
      )
      : undefined;
  const base = fromPermission ?? {};
  const configured: QiCapabilityConfig = {
    ...(pickBoolean(projectCaps?.write ?? globalCaps?.write ?? base.write, "write")),
    ...(pickBoolean(projectCaps?.verify ?? globalCaps?.verify ?? base.verify, "verify")),
    ...(pickBoolean(projectCaps?.network ?? globalCaps?.network ?? base.network, "network")),
    ...(pickBoolean(projectCaps?.execute ?? globalCaps?.execute ?? base.execute, "execute")),
    ...(pickBoolean(projectCaps?.background ?? globalCaps?.background ?? base.background, "background")),
    ...(pickBoolean(projectCaps?.delegate ?? globalCaps?.delegate ?? base.delegate, "delegate")),
    ...(pickBoolean(projectCaps?.publish ?? globalCaps?.publish ?? base.publish, "publish")),
    ...(pickBoolean(projectCaps?.spend ?? globalCaps?.spend ?? base.spend, "spend")),
  };
  return resolveCapabilities(configured, overrides);
}

function hasAnyCapabilityKey(caps: QiCapabilityConfig | undefined): boolean {
  if (!caps) return false;
  return (
    caps.write !== undefined
    || caps.verify !== undefined
    || caps.network !== undefined
    || caps.execute !== undefined
    || caps.background !== undefined
    || caps.delegate !== undefined
    || caps.publish !== undefined
    || caps.spend !== undefined
  );
}

/**
 * @deprecated Project `[shell]` no longer merges into launch authority (ADR-0015).
 * Prefer user-global `$QI_HOME/config.toml` via `ensureUserShellConfig` / `/shell`.
 */
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
  const permission = root.permission === undefined
    ? undefined
    : validateProjectPermission(root.permission, path);
  const sandbox = root.sandbox === undefined ? undefined : validateProjectSandbox(root.sandbox, path);
  const capabilities = root.capabilities === undefined
    ? undefined
    : validateCapabilities(root.capabilities, path);
  const shell = root.shell === undefined ? undefined : validateShell(root.shell, path);
  const mounts = root.mounts === undefined ? undefined : validateMounts(root.mounts, path);
  const approvals = root.approvals === undefined ? undefined : validateApprovals(root.approvals, path);
  const sensitivePathGrants = root.sensitive_path_grants === undefined
    ? undefined
    : validateSensitivePathGrants(root.sensitive_path_grants, path);
  const sensitivePaths = root.sensitive_paths === undefined
    ? undefined
    : validateSensitivePathPolicy(root.sensitive_paths, path);
  return {
    version: 1,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(permission === undefined ? {} : { permission }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(shell === undefined ? {} : { shell }),
    ...(mounts === undefined ? {} : { mounts }),
    ...(approvals === undefined ? {} : { approvals }),
    ...(sensitivePathGrants === undefined ? {} : { sensitivePathGrants }),
    ...(sensitivePaths === undefined ? {} : { sensitivePaths }),
  };
}

function validateApprovals(value: unknown, path: string): readonly QiProjectApprovalRecord[] {
  if (!Array.isArray(value)) throw new TypeError(`${path}: approvals must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${path}: approvals[${index}] must be a table`);
    }
    const table = entry as Record<string, unknown>;
    if (typeof table.pattern !== "string" || !table.pattern.trim()) {
      throw new TypeError(`${path}: approvals[${index}].pattern is required`);
    }
    if (table.decision !== "allow" && table.decision !== "deny") {
      throw new TypeError(`${path}: approvals[${index}].decision must be allow or deny`);
    }
    if (parseApprovalPattern(table.pattern) === undefined) {
      throw new TypeError(`${path}: approvals[${index}].pattern is not a valid approval pattern`);
    }
    const createdAt =
      typeof table.created_at === "string" && table.created_at
        ? table.created_at
        : new Date(0).toISOString();
    const source = typeof table.source === "string" ? table.source : undefined;
    return {
      pattern: table.pattern,
      decision: table.decision,
      createdAt,
      ...(source === undefined ? {} : { source }),
    };
  });
}

/** Convert project TOML approvals into runtime StoredApproval entries. */
export function storedApprovalsFromProject(
  records: readonly QiProjectApprovalRecord[] | undefined,
): StoredApproval[] {
  if (!records?.length) return [];
  const out: StoredApproval[] = [];
  for (const record of records) {
    const pattern = parseApprovalPattern(record.pattern);
    if (!pattern) continue;
    out.push({
      pattern,
      decision: record.decision,
      scope: "project",
      createdAt: record.createdAt,
      ...(record.source === undefined ? {} : { source: record.source }),
    });
  }
  return out;
}

export function projectApprovalFromStored(entry: StoredApproval): QiProjectApprovalRecord {
  return {
    pattern: serializeApprovalPattern(entry.pattern),
    decision: entry.decision,
    createdAt: entry.createdAt,
    ...(entry.source === undefined ? {} : { source: entry.source }),
  };
}

function validateProjectPermission(value: unknown, path: string): QiProjectPermissionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: permission must be a table`);
  }
  const table = value as Record<string, unknown>;
  if (table.mode === undefined) return {};
  if (table.mode !== "manual" && table.mode !== "yolo" && table.mode !== "auto") {
    throw new TypeError(`${path}: permission.mode must be manual, yolo, or auto`);
  }
  return { mode: table.mode };
}

function validateProjectSandbox(value: unknown, path: string): QiSandboxConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: sandbox must be a table`);
  }
  const table = value as Record<string, unknown>;
  if (table.policy === undefined) return {};
  if (
    table.policy !== "auto"
    && table.policy !== "srt"
    && table.policy !== "low-il"
    && table.policy !== "never"
  ) {
    throw new TypeError(`${path}: sandbox.policy must be auto, srt, low-il, or never`);
  }
  return { policy: table.policy };
}

/**
 * Resolve effective permission mode: CLI override > project > user default > manual.
 */
export function resolvePermissionMode(options: {
  readonly cli?: QiPermissionMode;
  readonly project?: QiProjectConfig;
  readonly user?: QiUserConfig;
}): PermissionMode {
  if (options.cli) return options.cli;
  if (options.project?.permission?.mode) return options.project.permission.mode;
  if (options.user?.permission?.default) return options.user.permission.default;
  return "manual";
}

/** Expand permission mode into QiCapabilityConfig when no explicit capability table is set. */
export function capabilityConfigFromPermissionMode(
  mode: PermissionMode,
  options: { readonly safe?: boolean } = {},
): QiCapabilityConfig {
  const pack = leasePackForPermissionMode(mode, options);
  return {
    write: pack.write,
    verify: pack.verify,
    network: pack.network,
    execute: pack.execute,
    background: pack.background,
    delegate: pack.delegate,
    publish: pack.publish,
    spend: pack.spend,
  };
}

function validateMaxSteps(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 8 || (value as number) > 1_000) {
    throw new TypeError(`${path}: max_steps must be an integer from 8 to 1000`);
  }
  return value as number;
}

function validateCapabilities(value: unknown, path: string): QiCapabilityConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: capabilities must be a table`);
  }
  const table = value as Record<string, unknown>;
  const out: QiCapabilityConfig = {};
  for (const key of ["write", "verify", "network", "execute", "background", "delegate", "publish", "spend"] as const) {
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

function validateSensitivePathGrants(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path}: sensitive_path_grants must be an array`);
  const seen = new Set<string>();
  const grants: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new TypeError(`${path}: sensitive_path_grants[${index}] must be a non-empty string`);
    }
    if (entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
      throw new TypeError(`${path}: sensitive_path_grants[${index}] must be a Workspace-relative path`);
    }
    const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    grants.push(normalized);
  }
  return grants;
}

function validateSensitivePathPolicy(value: unknown, path: string): ProjectSensitivePathPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path}: sensitive_paths must be a table`);
  }
  const table = value as Record<string, unknown>;
  const readList = (key: "extra" | "exclude"): string[] | undefined => {
    if (table[key] === undefined) return undefined;
    if (!Array.isArray(table[key]) || !(table[key] as unknown[]).every((item) => typeof item === "string" && item.trim())) {
      throw new TypeError(`${path}: sensitive_paths.${key} must be an array of non-empty strings`);
    }
    return [...new Set((table[key] as string[]).map((item) => item.replace(/\\/g, "/").trim()))];
  };
  const extra = readList("extra");
  const exclude = readList("exclude");
  return {
    ...(extra === undefined ? {} : { extra }),
    ...(exclude === undefined ? {} : { exclude }),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Re-export for callers that already hold a global user config shape. */
export type { QiUserConfig };
