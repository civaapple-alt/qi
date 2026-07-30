import { resolve } from "node:path";
import { providerModelContextTokens } from "@civaapple/qi-ai";
import { SessionIdSchema, assertSchema, type SessionId } from "@civaapple/qi-protocol";
import {
  defaultUserConfigPath,
  findCompatibleEndpoint,
  loadUserConfig,
  resolveLanguage,
  resolveTheme,
  resolveTimelineDensity,
  type CapabilityOverrides,
} from "./config.js";
import { defaultSessionDataRoot } from "./paths.js";
import {
  assertMountPathAllowed,
  loadProjectConfig,
  mergeCapabilities,
  mergeShell,
  projectConfigPathForWorkspace,
  suggestMountId,
  type ProjectMountConfig,
} from "./project-config.js";
import { resolveProviderConfig, type ProviderConfig } from "./provider.js";
import {
  TUI_DEFAULT_MAX_STEPS,
  TUI_DEFAULT_OUTPUT_RESERVE_TOKENS,
} from "./runtime.js";

export interface CliMountSpec {
  readonly id: string;
  readonly path: string;
  readonly mode: "read";
  readonly source: "project_config" | "cli";
}

export interface TuiCliOptions {
  workspaceRoot: string;
  dataRoot: string;
  provider: ProviderConfig;
  allowWrite: boolean;
  allowVerify: boolean;
  allowExecute: boolean;
  allowNetwork: boolean;
  allowBackground: boolean;
  allowDelegate: boolean;
  memoryEnabled: boolean;
  memoryAutoAcceptProject: boolean;
  image: import("./config.js").QiImageConfig;
  /** CLI `--allow-*` / `--safe` only; re-applied when refreshing project/user policy mid-process. */
  capabilityOverrides: CapabilityOverrides;
  /** True when launched with `--no-config` (skip user/project TOML on refresh). */
  noConfig: boolean;
  shell?: import("./config.js").QiShellConfig;
  language: import("./i18n.js").Locale;
  theme: import("./theme/colors.js").ThemeName;
  timelineDensity: import("./presenter.js").TimelineDensity;
  contextWindowTokens: number;
  /** True only for an explicit user `context_window_tokens`; model switches must otherwise refresh the window. */
  contextWindowTokensOverride: boolean;
  outputReserveTokens: number;
  maxSteps: number;
  /** Explicit CLI override retained across in-process Session relaunches. */
  maxStepsOverride?: number;
  configPath?: string;
  projectConfigPath?: string;
  mounts: readonly CliMountSpec[];
  sessionId?: SessionId;
}

export type ParsedTuiCli =
  | { kind: "help"; text: string }
  | { kind: "version"; text: string }
  | { kind: "run"; options: TuiCliOptions };

const HELP_TEXT =
  "qi [WORKSPACE] [options]\n" +
  "qi install|update SOURCE [--scope user|project] [--workspace PATH]\n" +
  "qi remove PACKAGE_ID [--scope user|project] [--workspace PATH]\n" +
  "qi list [--scope user|project] [--workspace PATH]\n" +
  "  WORKSPACE defaults to the current directory (same as `qi --workspace .`).\n" +
  "  Options: [--workspace PATH] [--data PATH] [--provider ID] [--model ID] [--effort LEVEL] [--base-url URL]\n" +
  "           [--session ID] [--max-steps 8..100] [--config PATH|--no-config] [--add-dir PATH]…\n" +
  "           [--allow-write|--no-write] [--allow-verify|--no-verify] [--allow-network|--no-network]\n" +
  "           [--allow-execute|--no-execute] [--allow-background|--no-background]\n" +
  "           [--allow-delegate|--no-delegate] [--safe]\n";

const BOOLEAN_FLAGS = [
  "--allow-write", "--allow-verify", "--allow-network", "--allow-execute", "--allow-background", "--allow-delegate",
  "--no-write", "--no-verify", "--no-network", "--no-execute", "--no-background", "--no-delegate", "--safe", "--no-config",
] as const;

const VALUE_FLAGS = [
  "--workspace", "--data", "--provider", "--model", "--effort", "--base-url", "--session", "--config", "--add-dir", "--max-steps",
] as const;

export function qiCliVersion(packageVersion = process.env.npm_package_version ?? "0.7.1"): string {
  return `qi ${packageVersion}`;
}

export async function parseTuiCliArguments(
  args: readonly string[],
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    packageVersion?: string;
  } = {},
): Promise<ParsedTuiCli> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const addDirs: string[] = [];
  let positionalWorkspace: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if ((BOOLEAN_FLAGS as readonly string[]).includes(argument ?? "")) {
      flags.add(argument!);
      continue;
    }
    if (argument === "--add-dir") {
      const value = args[index + 1];
      if (!value) throw new TypeError(`${argument} requires a value`);
      addDirs.push(value);
      index += 1;
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(argument ?? "")) {
      const value = args[index + 1];
      if (!value) throw new TypeError(`${argument} requires a value`);
      values.set(argument ?? "", value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { kind: "help", text: HELP_TEXT };
    }
    if (argument === "--version" || argument === "-V") {
      return { kind: "version", text: `${qiCliVersion(options.packageVersion)}\n` };
    }
    if (argument?.startsWith("-")) {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
    if (positionalWorkspace !== undefined) {
      throw new TypeError("Only one positional WORKSPACE path is allowed");
    }
    positionalWorkspace = argument;
  }

  if (flags.has("--no-config") && values.has("--config")) {
    throw new TypeError("--config and --no-config cannot be used together");
  }
  const capabilityFlags = BOOLEAN_FLAGS.filter((flag) => flag !== "--safe" && flag !== "--no-config");
  if (flags.has("--safe") && capabilityFlags.some((flag) => flags.has(flag))) {
    throw new TypeError("--safe cannot be combined with capability flags");
  }

  const overrides: CapabilityOverrides = {
    ...(flags.has("--safe") ? { safe: true } : {}),
    ...capabilityOverride(flags, "write"),
    ...capabilityOverride(flags, "verify"),
    ...capabilityOverride(flags, "network"),
    ...capabilityOverride(flags, "execute"),
    ...capabilityOverride(flags, "background"),
    ...capabilityOverride(flags, "delegate"),
  };
  const configuredPath = values.get("--config") ?? defaultUserConfigPath();
  const loaded = flags.has("--no-config")
    ? { path: configuredPath, exists: false, config: { version: 1 as const } }
    : await loadUserConfig(configuredPath);
  if (positionalWorkspace !== undefined && values.has("--workspace")) {
    throw new TypeError("Pass WORKSPACE as a positional path or --workspace, not both");
  }
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  // Bare `qi` uses the current directory; `--workspace` / positional path override.
  const workspaceRoot = resolve(cwd, values.get("--workspace") ?? positionalWorkspace ?? ".");
  const projectConfigPath = projectConfigPathForWorkspace(workspaceRoot, environment);
  const project = flags.has("--no-config")
    ? { path: projectConfigPath, exists: false, config: { version: 1 as const } }
    : await loadProjectConfig(projectConfigPath);
  const capabilities = mergeCapabilities(loaded.config.capabilities, project.config.capabilities, overrides);
  const shell = mergeShell(loaded.config.shell, project.config.shell);
  const dataRoot = values.has("--data")
    ? resolve(cwd, values.get("--data")!)
    : defaultSessionDataRoot(workspaceRoot, environment);
  const provider = resolveProviderConfig({
    ...(values.has("--provider") ? { provider: values.get("--provider")! } : {}),
    ...(values.has("--model") ? { model: values.get("--model")! } : {}),
    ...(values.has("--effort") ? { reasoningEffort: values.get("--effort")! } : {}),
    ...(values.has("--base-url") ? { baseURL: values.get("--base-url")! } : {}),
    defaults: {
      ...(loaded.config.provider === undefined ? {} : { provider: loaded.config.provider }),
      ...(loaded.config.model === undefined ? {} : { model: loaded.config.model }),
      ...(loaded.config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: loaded.config.reasoningEffort }),
      ...(loaded.config.baseURL === undefined ? {} : { baseURL: loaded.config.baseURL }),
      ...(loaded.config.accountAlias === undefined ? {} : { accountAlias: loaded.config.accountAlias }),
      ...(loaded.config.provider !== "compatible"
        ? {}
        : {
            imageInput: findCompatibleEndpoint(
              loaded.config,
              loaded.config.accountAlias ?? "default",
            )?.imageInput ?? false,
          }),
    },
    allowMissingCredential: true,
    environment,
  });
  const contextWindowTokens = loaded.config.contextWindowTokens
    ?? providerModelContextTokens(provider.profile, provider.model);
  const outputReserveTokens = Math.min(TUI_DEFAULT_OUTPUT_RESERVE_TOKENS, Math.floor(contextWindowTokens / 8));
  const maxSteps = values.has("--max-steps")
    ? parseMaxSteps(values.get("--max-steps")!, "--max-steps")
    : project.config.maxSteps ?? loaded.config.maxSteps ?? TUI_DEFAULT_MAX_STEPS;
  const mounts = buildLaunchMounts(project.config.mounts ?? [], addDirs, cwd);

  return {
    kind: "run",
    options: {
      workspaceRoot,
      dataRoot,
      provider,
      contextWindowTokens,
      contextWindowTokensOverride: loaded.config.contextWindowTokens !== undefined,
      outputReserveTokens,
      maxSteps,
      ...(values.has("--max-steps") ? { maxStepsOverride: maxSteps } : {}),
      language: resolveLanguage(loaded.config),
      theme: resolveTheme(loaded.config),
      timelineDensity: resolveTimelineDensity(loaded.config),
      ...capabilities,
      memoryEnabled: loaded.config.memory?.enabled ?? true,
      memoryAutoAcceptProject: loaded.config.memory?.autoAcceptProject ?? true,
      image: loaded.config.image ?? {},
      capabilityOverrides: overrides,
      noConfig: flags.has("--no-config"),
      ...(shell === undefined ? {} : { shell }),
      ...(loaded.exists ? { configPath: loaded.path } : {}),
      projectConfigPath,
      mounts,
      ...(values.has("--session")
        ? { sessionId: assertSchema(SessionIdSchema, values.get("--session"), "session ID") }
        : {}),
    },
  };
}

function parseMaxSteps(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new TypeError(`${label} must be an integer from 8 to 100`);
  const parsed = Number(value);
  if (parsed < 8 || parsed > 100) throw new TypeError(`${label} must be an integer from 8 to 100`);
  return parsed;
}

/**
 * Re-read user + project policy for an in-process relaunch (`/sessions` New Session or resume).
 * Preserves CLI `--allow-*` / `--safe` overrides from the original parse.
 */
export async function refreshLaunchCapabilities(
  options: TuiCliOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  allowWrite: boolean;
  allowVerify: boolean;
  allowNetwork: boolean;
  allowExecute: boolean;
  allowBackground: boolean;
  allowDelegate: boolean;
  maxSteps: number;
  projectConfigPath: string;
  shell?: import("./config.js").QiShellConfig;
}> {
  const projectConfigPath = options.projectConfigPath
    ?? projectConfigPathForWorkspace(options.workspaceRoot, environment);
  if (options.noConfig) {
    const caps = mergeCapabilities(undefined, undefined, options.capabilityOverrides);
    return {
      ...caps,
      projectConfigPath,
      maxSteps: options.maxStepsOverride ?? TUI_DEFAULT_MAX_STEPS,
    };
  }
  const loaded = options.configPath
    ? await loadUserConfig(options.configPath)
    : await loadUserConfig(defaultUserConfigPath(environment));
  const project = await loadProjectConfig(projectConfigPath);
  const caps = mergeCapabilities(
    loaded.config.capabilities,
    project.config.capabilities,
    options.capabilityOverrides,
  );
  const shell = mergeShell(loaded.config.shell, project.config.shell);
  return {
    ...caps,
    projectConfigPath,
    maxSteps: options.maxStepsOverride
      ?? project.config.maxSteps
      ?? loaded.config.maxSteps
      ?? TUI_DEFAULT_MAX_STEPS,
    ...(shell === undefined ? {} : { shell }),
  };
}

function buildLaunchMounts(
  projectMounts: readonly ProjectMountConfig[],
  addDirs: readonly string[],
  cwd: string,
): CliMountSpec[] {
  const mounts: CliMountSpec[] = [];
  const used = new Set<string>();
  for (const mount of projectMounts) {
    assertMountPathAllowed(mount.path);
    used.add(mount.id);
    mounts.push({ id: mount.id, path: mount.path, mode: "read", source: "project_config" });
  }
  for (const raw of addDirs) {
    const absolute = resolve(cwd, raw);
    assertMountPathAllowed(absolute);
    const id = suggestMountId(absolute, used);
    used.add(id);
    mounts.push({ id, path: absolute, mode: "read", source: "cli" });
  }
  return mounts;
}

function capabilityOverride(
  flags: ReadonlySet<string>,
  name: "write" | "verify" | "network" | "execute" | "background" | "delegate",
): Partial<CapabilityOverrides> {
  const positive = `--allow-${name}`;
  const negative = `--no-${name}`;
  if (flags.has(positive) && flags.has(negative)) {
    throw new TypeError(`${positive} and ${negative} cannot be used together`);
  }
  if (flags.has(positive)) return { [name]: true };
  if (flags.has(negative)) return { [name]: false };
  return {};
}
