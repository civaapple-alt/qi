import { resolve } from "node:path";
import { providerModelContextTokens, providerModelOutputReserveTokens } from "@civaapple/qi-ai";
import { defaultQiHome, ensureQiLayout } from "@civaapple/qi-node/paths";
import { SessionIdSchema, assertSchema, type SessionId } from "@civaapple/qi-protocol";
import {
  defaultUserConfigPath,
  ensureUserShellConfig,
  findCompatibleEndpoint,
  isQiSessionInspectEnabled,
  loadUserConfig,
  resolveDelegateConfig,
  resolveLanguage,
  resolveTheme,
  resolveTimelineDensity,
  type CapabilityOverrides,
  type ResolvedDelegateConfig,
} from "./config.js";
import { defaultSessionDataRoot } from "./paths.js";
import {
  assertMountPathAllowed,
  loadProjectConfig,
  mergeCapabilities,
  projectConfigPathForWorkspace,
  suggestMountId,
  type ProjectMountConfig,
} from "./project-config.js";
import { resolveProviderConfig, type ProviderConfig } from "./provider.js";
import {
  defaultProviderCatalogDirectory,
  loadAndInstallUserProviderCatalog,
} from "./provider-catalog-files.js";
import {
  assertMaxSteps,
  resolveOutputReserveTokens,
  TUI_DEFAULT_MAX_ACTIONS_PER_STEP,
  TUI_DEFAULT_MAX_STEPS,
  TUI_MAX_MAX_STEPS,
  TUI_MIN_MAX_STEPS,
} from "./runtime.js";

export interface CliMountSpec {
  readonly id: string;
  readonly path: string;
  readonly mode: "read";
  readonly source: "project_config" | "cli";
}

/** Headless / print-mode stdout formats (Cursor-compatible names). */
export type HeadlessOutputFormat = "text" | "json" | "stream-json";

export type SessionModeFlag = "ask" | "plan" | "agent";

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
  allowPublish: boolean;
  allowSpend: boolean;
  memoryEnabled: boolean;
  memoryAutoAcceptProject: boolean;
  /** When true, register model-facing `qi_session_inspect` (user config opt-in). */
  enableQiSessionInspect: boolean;
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
  /** Present when user config sets `output_reserve_tokens`; kept across model switches. */
  outputReserveTokensPreferred?: number;
  maxSteps: number;
  /** Explicit CLI override retained across in-process Session relaunches. */
  maxStepsOverride?: number;
  maxActionsPerStep: number;
  /** Resolved `[delegate]` Subagent envelope from user config. */
  delegateConfig: ResolvedDelegateConfig;
  configPath?: string;
  projectConfigPath?: string;
  mounts: readonly CliMountSpec[];
  sessionId?: SessionId;
  /**
   * One-shot non-interactive Run (`-p` / `--print`). Workspace is cwd or `--workspace` only;
   * the prompt is `--prompt` or remaining positionals.
   */
  print?: boolean;
  /** Required when `print` is true. */
  printPrompt?: string;
  outputFormat?: HeadlessOutputFormat;
  /** With `stream-json`, emit provisional text deltas from model activity. */
  streamPartialOutput?: boolean;
  /** Optional Session mode applied before the print Run. */
  sessionMode?: SessionModeFlag;
}

export type ParsedTuiCli =
  | { kind: "help"; text: string }
  | { kind: "version"; text: string }
  | { kind: "run"; options: TuiCliOptions };

const HELP_TEXT =
  "qi [WORKSPACE] [options]\n" +
  "qi -p|--print [PROMPT] [options]   One-shot headless Run (text|json|stream-json)\n" +
  "qi install|update SOURCE [--scope user|project] [--workspace PATH]\n" +
  "qi remove PACKAGE_ID [--scope user|project] [--workspace PATH]\n" +
  "qi list [--scope user|project] [--workspace PATH]\n" +
  "qi skill list|enable|disable|install SOURCE [--scope user|workspace] [--commit SHA --subdir PATH|--sha256 DIGEST] [--json]\n" +
  "qi mcp status|refresh|bind|unbind|logout [args] [--workspace PATH] [--json]\n" +
  "qi marketplace list|add|sync|search …\n" +
  "qi plugin list|commands|install|enable|disable|inspect …\n" +
  "qi agent list [query]\n" +
  "qi config show|validate|doctor [--workspace PATH] [--config PATH] [--json]\n" +
  "qi acp [options]   Agent Client Protocol server over stdio (IDE integration)\n" +
  "  WORKSPACE defaults to the current directory (same as `qi --workspace .`).\n" +
  "  Options: [--workspace PATH] [--data PATH] [--provider ID] [--model ID] [--effort LEVEL] [--base-url URL]\n" +
  "           [--session ID] [--max-steps 8..1000] [--config PATH|--no-config] [--add-dir PATH]…\n" +
  "           [--mode ask|plan|agent] [-p|--print] [--prompt TEXT] [--output-format text|json|stream-json]\n" +
  "           [--stream-partial-output]\n" +
  "           [--allow-write|--no-write] [--allow-verify|--no-verify] [--allow-network|--no-network]\n" +
  "           [--allow-execute|--no-execute] [--allow-background|--no-background]\n" +
  "           [--allow-delegate|--no-delegate] [--allow-publish|--no-publish] [--allow-spend|--no-spend] [--safe]\n" +
  "  Print mode: workspace is cwd or --workspace only; PROMPT is --prompt or remaining args.\n" +
  "  Writes need explicit --allow-write (or project policy), not a silent --force.\n";

const BOOLEAN_FLAGS = [
  "--allow-write", "--allow-verify", "--allow-network", "--allow-execute", "--allow-background", "--allow-delegate", "--allow-publish", "--allow-spend",
  "--no-write", "--no-verify", "--no-network", "--no-execute", "--no-background", "--no-delegate", "--no-publish", "--no-spend", "--safe", "--no-config",
  "--print", "-p", "--stream-partial-output",
] as const;

const VALUE_FLAGS = [
  "--workspace", "--data", "--provider", "--model", "--effort", "--base-url", "--session", "--config", "--add-dir", "--max-steps",
  "--output-format", "--prompt", "--mode",
] as const;

export function qiCliVersion(packageVersion = process.env.npm_package_version ?? "0.7.4"): string {
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
  const positionals: string[] = [];
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
    positionals.push(argument!);
  }

  const print = flags.has("--print") || flags.has("-p");
  if (flags.has("--no-config") && values.has("--config")) {
    throw new TypeError("--config and --no-config cannot be used together");
  }
  const capabilityFlags = BOOLEAN_FLAGS.filter(
    (flag) => flag !== "--safe" && flag !== "--no-config" && flag !== "--print" && flag !== "-p" && flag !== "--stream-partial-output",
  );
  if (flags.has("--safe") && capabilityFlags.some((flag) => flags.has(flag))) {
    throw new TypeError("--safe cannot be combined with capability flags");
  }
  if (flags.has("--stream-partial-output") && !print) {
    throw new TypeError("--stream-partial-output requires -p/--print");
  }
  if (values.has("--output-format") && !print) {
    throw new TypeError("--output-format requires -p/--print");
  }

  const overrides: CapabilityOverrides = {
    ...(flags.has("--safe") ? { safe: true } : {}),
    ...capabilityOverride(flags, "write"),
    ...capabilityOverride(flags, "verify"),
    ...capabilityOverride(flags, "network"),
    ...capabilityOverride(flags, "execute"),
    ...capabilityOverride(flags, "background"),
    ...capabilityOverride(flags, "delegate"),
    ...capabilityOverride(flags, "publish"),
    ...capabilityOverride(flags, "spend"),
  };
  const configuredPath = values.get("--config") ?? defaultUserConfigPath();
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;

  let printPrompt: string | undefined;
  let positionalWorkspace: string | undefined;
  if (print) {
    if (positionals.length > 0 && values.has("--workspace")) {
      // With --workspace, all positionals are the prompt (Cursor-style).
      printPrompt = positionals.join(" ");
    } else if (positionals.length > 0) {
      printPrompt = positionals.join(" ");
    }
    if (values.has("--prompt")) {
      const flagPrompt = values.get("--prompt")!.trim();
      if (!flagPrompt) throw new TypeError("--prompt must not be empty");
      printPrompt = printPrompt ? `${flagPrompt} ${printPrompt}` : flagPrompt;
    }
    if (!printPrompt?.trim()) {
      throw new TypeError("Print mode requires a prompt (-p \"…\" or --prompt TEXT)");
    }
    printPrompt = printPrompt.trim();
  } else {
    if (positionals.length > 1) {
      throw new TypeError("Only one positional WORKSPACE path is allowed");
    }
    positionalWorkspace = positionals[0];
    if (positionalWorkspace !== undefined && values.has("--workspace")) {
      throw new TypeError("Pass WORKSPACE as a positional path or --workspace, not both");
    }
  }

  await loadAndInstallUserProviderCatalog(defaultProviderCatalogDirectory(environment));
  // Bare `qi` uses the current directory; `--workspace` / positional path override.
  // Print mode never treats positionals as workspace (use --workspace).
  const workspaceRoot = resolve(cwd, values.get("--workspace") ?? positionalWorkspace ?? ".");

  const outputFormatRaw = values.get("--output-format") ?? (print ? "text" : undefined);
  if (outputFormatRaw !== undefined
    && outputFormatRaw !== "text"
    && outputFormatRaw !== "json"
    && outputFormatRaw !== "stream-json") {
    throw new TypeError("--output-format must be text, json, or stream-json");
  }
  const outputFormat = outputFormatRaw as HeadlessOutputFormat | undefined;
  if (flags.has("--stream-partial-output") && outputFormat !== "stream-json") {
    throw new TypeError("--stream-partial-output requires --output-format stream-json");
  }

  const modeRaw = values.get("--mode")?.toLowerCase();
  if (modeRaw !== undefined && modeRaw !== "ask" && modeRaw !== "plan" && modeRaw !== "agent") {
    throw new TypeError("--mode must be ask, plan, or agent");
  }
  const sessionMode = modeRaw as SessionModeFlag | undefined;
  // Initialize $QI_HOME layout before first-run shell probing writes config.toml.
  // Otherwise a config-only home is misclassified as unsupported pre-0.6 layout.
  // Skip workspaceRoot here: containment is enforced later in ensureProjectLayout;
  // parse-time tests often place a temporary QI_HOME under the workspace.
  await ensureQiLayout(defaultQiHome(environment));
  const loaded = flags.has("--no-config")
    ? { path: configuredPath, exists: false, config: { version: 1 as const } }
    : await ensureUserShellConfig(workspaceRoot, configuredPath);
  const projectConfigPath = projectConfigPathForWorkspace(workspaceRoot, environment);
  const project = flags.has("--no-config")
    ? { path: projectConfigPath, exists: false, config: { version: 1 as const } }
    : await loadProjectConfig(projectConfigPath);
  const capabilities = mergeCapabilities(loaded.config.capabilities, project.config.capabilities, overrides);
  // Shell profiles are user-global only ($QI_HOME/config.toml); project policy.toml [shell] is ignored.
  const shell = loaded.config.shell;
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
      ...(loaded.config.provider === "compatible"
        ? {
            imageInput: findCompatibleEndpoint(
              loaded.config,
              loaded.config.accountAlias ?? "default",
            )?.imageInput ?? loaded.config.imageInput ?? false,
          }
        : (loaded.config.imageInput === undefined ? {} : { imageInput: loaded.config.imageInput })),
    },
    allowMissingCredential: true,
    environment,
  });
  const contextWindowTokens = loaded.config.contextWindowTokens
    ?? providerModelContextTokens(provider.profile, provider.model);
  const outputReserveTokensPreferred = loaded.config.outputReserveTokens;
  const outputReserveTokens = resolveOutputReserveTokens(
    contextWindowTokens,
    outputReserveTokensPreferred
      ?? providerModelOutputReserveTokens(provider.profile, provider.model),
  );
  const maxSteps = values.has("--max-steps")
    ? parseMaxSteps(values.get("--max-steps")!, "--max-steps")
    : project.config.maxSteps ?? loaded.config.maxSteps ?? TUI_DEFAULT_MAX_STEPS;
  const maxActionsPerStep = loaded.config.maxActionsPerStep ?? TUI_DEFAULT_MAX_ACTIONS_PER_STEP;
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
      ...(outputReserveTokensPreferred === undefined
        ? {}
        : { outputReserveTokensPreferred }),
      maxSteps,
      ...(values.has("--max-steps") ? { maxStepsOverride: maxSteps } : {}),
      maxActionsPerStep,
      delegateConfig: resolveDelegateConfig(loaded.config.delegate),
      language: resolveLanguage(loaded.config),
      theme: resolveTheme(loaded.config),
      timelineDensity: resolveTimelineDensity(loaded.config),
      ...capabilities,
      memoryEnabled: loaded.config.memory?.enabled ?? true,
      memoryAutoAcceptProject: loaded.config.memory?.autoAcceptProject ?? true,
      enableQiSessionInspect: isQiSessionInspectEnabled(loaded.config),
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
      ...(print ? { print: true, printPrompt: printPrompt! } : {}),
      ...(outputFormat === undefined ? {} : { outputFormat }),
      ...(flags.has("--stream-partial-output") ? { streamPartialOutput: true } : {}),
      ...(sessionMode === undefined ? {} : { sessionMode }),
    },
  };
}

function parseMaxSteps(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${label} must be an integer from ${TUI_MIN_MAX_STEPS} to ${TUI_MAX_MAX_STEPS}`);
  }
  try {
    return assertMaxSteps(Number(value), label);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : String(error));
  }
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
  allowPublish: boolean;
  allowSpend: boolean;
  maxSteps: number;
  maxActionsPerStep: number;
  outputReserveTokensPreferred?: number;
  projectConfigPath: string;
  shell?: import("./config.js").QiShellConfig;
  delegateConfig: ResolvedDelegateConfig;
}> {
  const projectConfigPath = options.projectConfigPath
    ?? projectConfigPathForWorkspace(options.workspaceRoot, environment);
  if (options.noConfig) {
    const caps = mergeCapabilities(undefined, undefined, options.capabilityOverrides);
    return {
      ...caps,
      projectConfigPath,
      maxSteps: options.maxStepsOverride ?? TUI_DEFAULT_MAX_STEPS,
      maxActionsPerStep: options.maxActionsPerStep ?? TUI_DEFAULT_MAX_ACTIONS_PER_STEP,
      delegateConfig: resolveDelegateConfig(),
      ...(options.outputReserveTokensPreferred === undefined
        ? {}
        : { outputReserveTokensPreferred: options.outputReserveTokensPreferred }),
    };
  }
  const loaded = options.configPath
    ? await ensureUserShellConfig(options.workspaceRoot, options.configPath)
    : await ensureUserShellConfig(options.workspaceRoot, defaultUserConfigPath(environment));
  const project = await loadProjectConfig(projectConfigPath);
  const caps = mergeCapabilities(
    loaded.config.capabilities,
    project.config.capabilities,
    options.capabilityOverrides,
  );
  // Shell profiles are user-global only; project policy.toml [shell] is ignored.
  const shell = loaded.config.shell;
  return {
    ...caps,
    projectConfigPath,
    maxSteps: options.maxStepsOverride
      ?? project.config.maxSteps
      ?? loaded.config.maxSteps
      ?? TUI_DEFAULT_MAX_STEPS,
    maxActionsPerStep: loaded.config.maxActionsPerStep ?? TUI_DEFAULT_MAX_ACTIONS_PER_STEP,
    delegateConfig: resolveDelegateConfig(loaded.config.delegate),
    ...(loaded.config.outputReserveTokens === undefined
      ? {}
      : { outputReserveTokensPreferred: loaded.config.outputReserveTokens }),
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
  name: "write" | "verify" | "network" | "execute" | "background" | "delegate" | "publish" | "spend",
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
