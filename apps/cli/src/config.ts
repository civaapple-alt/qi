import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  getProviderModelProfile,
  getProviderProfile,
  normalizeKimiReasoningEffort,
} from "@civaapple/qi-ai";
import { defaultLocale, type Locale } from "./i18n.js";
import {
  normalizeAccountAlias,
  validateProviderBaseURL,
  type QiProvider,
} from "./provider.js";
import type { ThemeName } from "./theme/colors.js";
import type { TimelineDensity } from "./presenter.js";

const userConfigLimitBytes = 64 * 1024;
const shellProfileIds = ["direct", "pwsh", "cmd", "bash"] as const;
const localeIds = ["zh", "en"] as const;
const themeIds = ["dark", "light", "auto"] as const;
const timelineDensityIds = ["compact", "standard", "diagnostic"] as const;

export type ConfigShellProfileId = (typeof shellProfileIds)[number];
export type ConfigLanguage = Locale;
export type ConfigTheme = ThemeName;
export type ConfigTimelineDensity = TimelineDensity;

export interface QiCapabilityConfig {
  readonly write?: boolean;
  readonly verify?: boolean;
  readonly network?: boolean;
  readonly execute?: boolean;
  readonly background?: boolean;
  readonly delegate?: boolean;
}

export interface QiShellConfig {
  readonly default?: ConfigShellProfileId;
  readonly allowed?: readonly ConfigShellProfileId[];
}

export interface QiMemoryConfig {
  readonly enabled?: boolean;
  readonly autoAcceptProject?: boolean;
}

export interface QiUiConfig {
  readonly timelineDensity?: ConfigTimelineDensity;
}

export interface QiImageConfig {
  readonly maxEdgePx?: number;
  readonly readByteBudget?: number;
}

/** Non-secret OpenAI-compatible endpoint catalog entry (secrets stay sealed). */
export interface CompatibleEndpoint {
  readonly name: string;
  readonly baseURL: string;
  readonly model: string;
  readonly imageInput?: boolean;
}

export interface QiUserConfig {
  readonly version: 1;
  readonly language?: ConfigLanguage;
  readonly theme?: ConfigTheme;
  readonly provider?: QiProvider;
  readonly model?: string;
  readonly baseURL?: string;
  readonly accountAlias?: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "max" | "none";
  /** Saved OpenAI-compatible endpoints; active selection is the top-level fields. */
  readonly compatible?: readonly CompatibleEndpoint[];
  readonly contextWindowTokens?: number;
  /**
   * Preferred next-response reserve (`max_output_tokens` / thinking-inclusive budget).
   * Still hard-capped at 1/8 of the context window at resolve time.
   */
  readonly outputReserveTokens?: number;
  readonly imageInput?: boolean;
  readonly maxSteps?: number;
  /** Max model Action proposals executed per Step (TurnLoop batch envelope). */
  readonly maxActionsPerStep?: number;
  readonly capabilities?: QiCapabilityConfig;
  readonly shell?: QiShellConfig;
  readonly memory?: QiMemoryConfig;
  readonly ui?: QiUiConfig;
  readonly image?: QiImageConfig;
}

export interface LoadedUserConfig {
  readonly path: string;
  readonly exists: boolean;
  readonly config: QiUserConfig;
}

export interface CapabilityOverrides {
  readonly safe?: boolean;
  readonly write?: boolean;
  readonly verify?: boolean;
  readonly network?: boolean;
  readonly execute?: boolean;
  readonly background?: boolean;
  readonly delegate?: boolean;
}

export interface ResolvedCapabilities {
  readonly allowWrite: boolean;
  readonly allowVerify: boolean;
  readonly allowNetwork: boolean;
  readonly allowExecute: boolean;
  readonly allowBackground: boolean;
  readonly allowDelegate: boolean;
}

export function defaultUserConfigPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory = homedir(),
): string {
  const explicit = optionalString(environment.QI_CONFIG);
  if (explicit !== undefined) return resolve(explicit);
  const qiHome = optionalString(environment.QI_HOME);
  return qiHome === undefined
    ? resolve(homeDirectory, ".qi", "config.toml")
    : resolve(qiHome, "config.toml");
}

export async function loadUserConfig(path = defaultUserConfigPath()): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return { path: absolute, exists: false, config: { version: 1 } };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new TypeError(`Qi config must be a regular, non-symlink file: ${absolute}`);
  }
  if (info.size > userConfigLimitBytes) {
    throw new TypeError(`Qi config exceeds ${userConfigLimitBytes} bytes: ${absolute}`);
  }
  let decoded: unknown;
  try {
    decoded = parse((await readFile(absolute, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new TypeError(`Invalid Qi TOML config ${absolute}: ${message(error)}`);
  }
  return { path: absolute, exists: true, config: validateUserConfig(decoded, absolute) };
}

export interface UserProviderDefaults {
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly accountAlias?: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "max" | "none";
  readonly contextWindowTokens?: number;
  readonly outputReserveTokens?: number;
  readonly imageInput?: boolean;
}

/**
 * Persist non-secret provider routing defaults after `/login`.
 * Merges into the existing user config.toml (creates it when missing); never writes API keys.
 * When provider is `compatible`, upserts the active endpoint into `[[compatible]]`.
 */
export async function persistUserProviderDefaults(
  selection: UserProviderDefaults,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const catalog = selection.provider === "compatible" && selection.baseURL
    ? upsertCompatibleEndpoint(loaded.config.compatible, {
      name: normalizeAccountAlias(selection.accountAlias),
      baseURL: selection.baseURL,
      model: selection.model,
      ...(selection.imageInput === undefined ? {} : { imageInput: selection.imageInput }),
    })
    : loaded.config.compatible;
  const profile = getProviderProfile(selection.provider);
  const alwaysOnThinking = profile !== undefined
    && getProviderModelProfile(profile, selection.model)?.thinking?.mode === "always";
  // Always-on models (Kimi K2.7 Code) must not keep a stale K3 effort in config.toml.
  const reasoningEffort = alwaysOnThinking
    ? undefined
    : selection.reasoningEffort ?? loaded.config.reasoningEffort;
  const contextWindowTokens = selection.contextWindowTokens ?? loaded.config.contextWindowTokens;
  const next: QiUserConfig = {
    version: 1,
    ...(loaded.config.language === undefined ? {} : { language: loaded.config.language }),
    ...(loaded.config.theme === undefined ? {} : { theme: loaded.config.theme }),
    provider: selection.provider,
    model: selection.model,
    ...(selection.baseURL === undefined ? {} : { baseURL: selection.baseURL }),
    ...(selection.accountAlias === undefined ? {} : { accountAlias: selection.accountAlias }),
    ...(!providerPersistsReasoningEffort(selection.provider) || reasoningEffort === undefined
      ? {}
      : { reasoningEffort }),
    ...(catalog === undefined || catalog.length === 0 ? {} : { compatible: catalog }),
    ...(contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens }),
    ...(selection.outputReserveTokens === undefined
      ? (loaded.config.outputReserveTokens === undefined
        ? {}
        : { outputReserveTokens: loaded.config.outputReserveTokens })
      : { outputReserveTokens: selection.outputReserveTokens }),
    ...(loaded.config.maxSteps === undefined ? {} : { maxSteps: loaded.config.maxSteps }),
    ...(loaded.config.maxActionsPerStep === undefined
      ? {}
      : { maxActionsPerStep: loaded.config.maxActionsPerStep }),
    ...(loaded.config.capabilities === undefined ? {} : { capabilities: loaded.config.capabilities }),
    ...(loaded.config.shell === undefined ? {} : { shell: loaded.config.shell }),
    ...(loaded.config.memory === undefined ? {} : { memory: loaded.config.memory }),
    ...(loaded.config.ui === undefined ? {} : { ui: loaded.config.ui }),
    ...(loaded.config.image === undefined ? {} : { image: loaded.config.image }),
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

/**
 * Switch the active OpenAI-compatible endpoint from the saved catalog (non-secret fields only).
 * Caller must hydrate the sealed credential separately via AuthSession.useAccount.
 */
export async function persistActiveCompatible(
  name: string,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const alias = normalizeAccountAlias(name);
  const entry = loaded.config.compatible?.find((item) => item.name === alias);
  if (!entry) {
    throw new TypeError(
      `Unknown compatible endpoint "${alias}". Login first or add a [[compatible]] entry in ${absolute}`,
    );
  }
  return persistUserProviderDefaults(
    {
      provider: "compatible",
      accountAlias: entry.name,
      model: entry.model,
      baseURL: entry.baseURL,
    },
    absolute,
  );
}

/** Remove a named endpoint from the catalog (does not touch sealed credentials). */
export async function removeCompatibleEndpoint(
  name: string,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const alias = normalizeAccountAlias(name);
  const catalog = (loaded.config.compatible ?? []).filter((item) => item.name !== alias);
  const next: QiUserConfig = {
    version: 1,
    ...(loaded.config.language === undefined ? {} : { language: loaded.config.language }),
    ...(loaded.config.theme === undefined ? {} : { theme: loaded.config.theme }),
    ...(loaded.config.provider === undefined ? {} : { provider: loaded.config.provider }),
    ...(loaded.config.model === undefined ? {} : { model: loaded.config.model }),
    ...(loaded.config.baseURL === undefined ? {} : { baseURL: loaded.config.baseURL }),
    ...(loaded.config.accountAlias === undefined ? {} : { accountAlias: loaded.config.accountAlias }),
    ...(loaded.config.reasoningEffort === undefined ? {} : { reasoningEffort: loaded.config.reasoningEffort }),
    ...(catalog.length === 0 ? {} : { compatible: catalog }),
    ...(loaded.config.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: loaded.config.contextWindowTokens }),
    ...(loaded.config.outputReserveTokens === undefined
      ? {}
      : { outputReserveTokens: loaded.config.outputReserveTokens }),
    ...(loaded.config.maxSteps === undefined ? {} : { maxSteps: loaded.config.maxSteps }),
    ...(loaded.config.maxActionsPerStep === undefined
      ? {}
      : { maxActionsPerStep: loaded.config.maxActionsPerStep }),
    ...(loaded.config.capabilities === undefined ? {} : { capabilities: loaded.config.capabilities }),
    ...(loaded.config.shell === undefined ? {} : { shell: loaded.config.shell }),
    ...(loaded.config.memory === undefined ? {} : { memory: loaded.config.memory }),
    ...(loaded.config.ui === undefined ? {} : { ui: loaded.config.ui }),
    ...(loaded.config.image === undefined ? {} : { image: loaded.config.image }),
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

export function upsertCompatibleEndpoint(
  existing: readonly CompatibleEndpoint[] | undefined,
  entry: CompatibleEndpoint,
): readonly CompatibleEndpoint[] {
  const name = normalizeAccountAlias(entry.name);
  const previous = existing?.find((item) => item.name === name);
  const imageInput = entry.imageInput ?? previous?.imageInput;
  const next: CompatibleEndpoint = {
    name,
    baseURL: validateProviderBaseURL(entry.baseURL, "compatible base URL"),
    model: entry.model.trim(),
    ...(imageInput === undefined
      ? {}
      : { imageInput }),
  };
  if (!next.model) throw new TypeError("compatible model is required");
  const others = (existing ?? []).filter((item) => item.name !== name);
  return Object.freeze([...others, next]);
}

export function findCompatibleEndpoint(
  config: QiUserConfig,
  name: string,
): CompatibleEndpoint | undefined {
  const alias = normalizeAccountAlias(name);
  return config.compatible?.find((item) => item.name === alias);
}

/**
 * Persist UI language into the user config.toml (creates it when missing).
 * Preserves provider routing and capability settings.
 */
export async function persistUserLanguage(
  language: ConfigLanguage,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const next: QiUserConfig = {
    ...loaded.config,
    version: 1,
    language,
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

export function resolveLanguage(config: QiUserConfig | undefined): ConfigLanguage {
  return config?.language ?? defaultLocale();
}

/**
 * Persist TUI theme preference into the user config.toml (creates it when missing).
 */
export async function persistUserTheme(
  theme: ConfigTheme,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const next: QiUserConfig = {
    ...loaded.config,
    version: 1,
    theme,
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

export function resolveTheme(config: QiUserConfig | undefined): ConfigTheme {
  return config?.theme ?? "auto";
}

export function resolveTimelineDensity(config: QiUserConfig | undefined): ConfigTimelineDensity {
  return config?.ui?.timelineDensity ?? "standard";
}

export async function persistUserTimelineDensity(
  timelineDensity: ConfigTimelineDensity,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const next: QiUserConfig = {
    ...loaded.config,
    version: 1,
    ui: { ...loaded.config.ui, timelineDensity },
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

/**
 * Persist `[shell]` profiles into the user config.toml (creates it when missing).
 */
export async function persistUserShell(
  shell: QiShellConfig,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  if (!shell.allowed || shell.allowed.length === 0) {
    throw new TypeError("shell.allowed must contain at least one profile");
  }
  const defaultProfile = shell.default ?? (shell.allowed.includes("direct") ? "direct" : shell.allowed[0]!);
  if (!shell.allowed.includes(defaultProfile)) {
    throw new TypeError(`shell.default ${defaultProfile} must be listed in shell.allowed`);
  }
  const next: QiUserConfig = {
    ...loaded.config,
    version: 1,
    shell: {
      default: defaultProfile,
      allowed: [...shell.allowed],
    },
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

/**
 * Persist top-level `max_steps` into the user config.toml (creates it when missing).
 */
export async function persistUserMaxSteps(
  maxSteps: number,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  if (!Number.isInteger(maxSteps) || maxSteps < 8 || maxSteps > 1_000) {
    throw new RangeError("max_steps must be an integer from 8 to 1000");
  }
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const next: QiUserConfig = {
    ...loaded.config,
    version: 1,
    maxSteps,
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

/**
 * Persist top-level `max_actions_per_step` into the user config.toml (creates it when missing).
 */
export async function persistUserMaxActionsPerStep(
  maxActionsPerStep: number,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  if (!Number.isInteger(maxActionsPerStep) || maxActionsPerStep < 1 || maxActionsPerStep > 32) {
    throw new RangeError("max_actions_per_step must be an integer from 1 to 32");
  }
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  const next: QiUserConfig = {
    ...loaded.config,
    version: 1,
    maxActionsPerStep,
  };
  await saveUserConfig(absolute, next);
  return { path: absolute, exists: true, config: next };
}

/**
 * Ensure `$QI_HOME/config.toml` has `[shell]`. When missing, probe installed profiles for this OS,
 * write them once, and return the updated config. Existing `[shell]` is left unchanged.
 */
export async function ensureUserShellConfig(
  workspaceRoot: string,
  path = defaultUserConfigPath(),
): Promise<LoadedUserConfig> {
  const absolute = resolve(path);
  const loaded = await loadUserConfig(absolute);
  if (loaded.config.shell?.allowed !== undefined && loaded.config.shell.allowed.length > 0) {
    return loaded;
  }
  const { detectInstalledShellProfiles } = await import("@civaapple/qi-node/tools");
  const detected = await detectInstalledShellProfiles(workspaceRoot);
  return persistUserShell(detected, absolute);
}

export async function saveUserConfig(path: string, config: QiUserConfig): Promise<void> {
  const absolute = resolve(path);
  const encodedCompatible = config.compatible?.map((entry) => ({
    name: entry.name,
    base_url: entry.baseURL,
    model: entry.model,
    ...(entry.imageInput === undefined ? {} : { image_input: entry.imageInput }),
  }));
  validateUserConfig(
    {
      version: config.version,
      ...(config.language === undefined ? {} : { language: config.language }),
      ...(config.theme === undefined ? {} : { theme: config.theme }),
      ...(config.provider === undefined ? {} : { provider: config.provider }),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.baseURL === undefined ? {} : { base_url: config.baseURL }),
      ...(config.accountAlias === undefined ? {} : { account_alias: config.accountAlias }),
      ...(config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort }),
      ...(encodedCompatible === undefined ? {} : { compatible: encodedCompatible }),
      ...(config.contextWindowTokens === undefined
        ? {}
        : { context_window_tokens: config.contextWindowTokens }),
      ...(config.outputReserveTokens === undefined
        ? {}
        : { output_reserve_tokens: config.outputReserveTokens }),
      ...(config.maxSteps === undefined ? {} : { max_steps: config.maxSteps }),
      ...(config.maxActionsPerStep === undefined
        ? {}
        : { max_actions_per_step: config.maxActionsPerStep }),
      ...(config.capabilities === undefined ? {} : { capabilities: { ...config.capabilities } }),
      ...(config.shell === undefined
        ? {}
        : {
            shell: {
              ...config.shell,
              ...(config.shell.allowed === undefined ? {} : { allowed: [...config.shell.allowed] }),
            },
          }),
      ...(config.memory === undefined
        ? {}
        : {
            memory: {
              ...(config.memory.enabled === undefined ? {} : { enabled: config.memory.enabled }),
              ...(config.memory.autoAcceptProject === undefined
                ? {}
                : { auto_accept_project: config.memory.autoAcceptProject }),
            },
          }),
      ...(config.ui === undefined
        ? {}
        : {
            ui: {
              ...(config.ui.timelineDensity === undefined
                ? {}
                : { timeline_density: config.ui.timelineDensity }),
            },
          }),
      ...(config.image === undefined
        ? {}
        : {
            image: {
              ...(config.image.maxEdgePx === undefined ? {} : { max_edge_px: config.image.maxEdgePx }),
              ...(config.image.readByteBudget === undefined
                ? {}
                : { read_byte_budget: config.image.readByteBudget }),
            },
          }),
    },
    absolute,
  );
  await mkdir(dirname(absolute), { recursive: true });
  const body = stringify({
    version: 1,
    ...(config.language === undefined ? {} : { language: config.language }),
    ...(config.theme === undefined ? {} : { theme: config.theme }),
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.baseURL === undefined ? {} : { base_url: config.baseURL }),
    ...(config.accountAlias === undefined ? {} : { account_alias: config.accountAlias }),
    ...(config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort }),
    ...(encodedCompatible === undefined || encodedCompatible.length === 0
      ? {}
      : { compatible: encodedCompatible }),
    ...(config.contextWindowTokens === undefined
      ? {}
      : { context_window_tokens: config.contextWindowTokens }),
    ...(config.outputReserveTokens === undefined
      ? {}
      : { output_reserve_tokens: config.outputReserveTokens }),
    ...(config.maxSteps === undefined ? {} : { max_steps: config.maxSteps }),
    ...(config.maxActionsPerStep === undefined
      ? {}
      : { max_actions_per_step: config.maxActionsPerStep }),
    ...(config.capabilities === undefined ? {} : { capabilities: { ...config.capabilities } }),
    ...(config.shell === undefined
      ? {}
      : {
          shell: {
            ...config.shell,
            ...(config.shell.allowed === undefined ? {} : { allowed: [...config.shell.allowed] }),
          },
        }),
    ...(config.memory === undefined
      ? {}
      : {
          memory: {
            ...(config.memory.enabled === undefined ? {} : { enabled: config.memory.enabled }),
            ...(config.memory.autoAcceptProject === undefined
              ? {}
              : { auto_accept_project: config.memory.autoAcceptProject }),
          },
        }),
    ...(config.ui === undefined
      ? {}
      : {
          ui: {
            ...(config.ui.timelineDensity === undefined
              ? {}
              : { timeline_density: config.ui.timelineDensity }),
          },
        }),
    ...(config.image === undefined
      ? {}
      : {
          image: {
            ...(config.image.maxEdgePx === undefined ? {} : { max_edge_px: config.image.maxEdgePx }),
            ...(config.image.readByteBudget === undefined
              ? {}
              : { read_byte_budget: config.image.readByteBudget }),
          },
        }),
  });
  if (Buffer.byteLength(body, "utf8") > userConfigLimitBytes) {
    throw new TypeError(`Qi config exceeds ${userConfigLimitBytes} bytes: ${absolute}`);
  }
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${body}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveCapabilities(
  configured: QiCapabilityConfig | undefined,
  overrides: CapabilityOverrides = {},
): ResolvedCapabilities {
  if (overrides.safe) {
    return {
      allowWrite: false,
      allowVerify: false,
      allowNetwork: false,
      allowExecute: false,
      allowBackground: false,
      allowDelegate: false,
    };
  }
  return {
    allowWrite: overrides.write ?? configured?.write ?? false,
    allowVerify: overrides.verify ?? configured?.verify ?? false,
    allowNetwork: overrides.network ?? configured?.network ?? false,
    allowExecute: overrides.execute ?? configured?.execute ?? false,
    allowBackground: overrides.background ?? configured?.background ?? false,
    allowDelegate: overrides.delegate ?? configured?.delegate ?? false,
  };
}

function validateUserConfig(value: unknown, path: string): QiUserConfig {
  const root = requireTable(value, path);
  assertOnlyKeys(root, [
    "version",
    "language",
    "theme",
    "provider",
    "model",
    "base_url",
    "account_alias",
    "reasoning_effort",
    "compatible",
    "context_window_tokens",
    "output_reserve_tokens",
    "max_steps",
    "max_actions_per_step",
    "capabilities",
    "shell",
    "memory",
    "ui",
    "image",
  ], path);
  const version = root.version ?? 1;
  if (version !== 1) throw new TypeError(`${path}: version must be 1`);
  const language = optionalLanguageField(root.language, `${path}: language`);
  const theme = optionalThemeField(root.theme, `${path}: theme`);
  const provider = optionalStringField(root.provider, `${path}: provider`);
  if (provider !== undefined) {
    const known = [
      "openai",
      "xai",
      "kimi",
      "deepseek",
      "volcengine-agent-plan",
      "qianwenai",
      "moonshot",
      "compatible",
    ];
    if (!known.includes(provider)) {
      throw new TypeError(`${path}: provider must be one of ${known.join(", ")}`);
    }
  }
  const model = optionalStringField(root.model, `${path}: model`, 256);
  const baseURL = optionalStringField(root.base_url, `${path}: base_url`, 2_048);
  const accountAlias = optionalStringField(root.account_alias, `${path}: account_alias`, 128);
  const rawReasoningEffort = optionalStringField(root.reasoning_effort, `${path}: reasoning_effort`, 32);
  const reasoningEffort = normalizeKimiReasoningEffort(rawReasoningEffort);
  const compatible = optionalCompatibleList(root.compatible, `${path}: compatible`);
  const contextWindowTokens = optionalIntegerField(
    root.context_window_tokens,
    `${path}: context_window_tokens`,
    8_192,
    2_000_000,
  );
  const outputReserveTokens = optionalIntegerField(
    root.output_reserve_tokens,
    `${path}: output_reserve_tokens`,
    1,
    2_000_000,
  );
  const maxSteps = optionalIntegerField(root.max_steps, `${path}: max_steps`, 8, 1_000);
  const maxActionsPerStep = optionalIntegerField(
    root.max_actions_per_step,
    `${path}: max_actions_per_step`,
    1,
    32,
  );
  if ((model !== undefined || baseURL !== undefined || reasoningEffort !== undefined) && provider === undefined) {
    throw new TypeError(`${path}: provider is required when model, base_url, or reasoning_effort is configured`);
  }
  if (reasoningEffort !== undefined && !providerPersistsReasoningEffort(provider)) {
    throw new TypeError(
      `${path}: reasoning_effort is currently supported only when provider = "kimi", "deepseek", "volcengine-agent-plan", or "qianwenai"`,
    );
  }
  let capabilities: QiCapabilityConfig | undefined;
  if (root.capabilities !== undefined) {
    const table = requireTable(root.capabilities, `${path}: capabilities`);
    assertOnlyKeys(table, ["write", "verify", "network", "execute", "background", "delegate"], `${path}: capabilities`);
    capabilities = {
      ...booleanField(table, "write", path),
      ...booleanField(table, "verify", path),
      ...booleanField(table, "network", path),
      ...booleanField(table, "execute", path),
      ...booleanField(table, "background", path),
      ...booleanField(table, "delegate", path),
    };
  }
  let shell: QiShellConfig | undefined;
  if (root.shell !== undefined) {
    const table = requireTable(root.shell, `${path}: shell`);
    assertOnlyKeys(table, ["default", "allowed"], `${path}: shell`);
    const allowed = optionalShellProfileList(table.allowed, `${path}: shell.allowed`);
    const defaultProfile = optionalShellProfile(table.default, `${path}: shell.default`);
    if (defaultProfile !== undefined && allowed !== undefined && !allowed.includes(defaultProfile)) {
      throw new TypeError(`${path}: shell.default must be listed in shell.allowed`);
    }
    if (allowed !== undefined && allowed.length === 0) {
      throw new TypeError(`${path}: shell.allowed must not be empty`);
    }
    shell = {
      ...(defaultProfile === undefined ? {} : { default: defaultProfile }),
      ...(allowed === undefined ? {} : { allowed }),
    };
  }
  let memory: QiMemoryConfig | undefined;
  if (root.memory !== undefined) {
    const table = requireTable(root.memory, `${path}: memory`);
    assertOnlyKeys(table, ["enabled", "auto_accept_project"], `${path}: memory`);
    const enabled = optionalBooleanField(table.enabled, `${path}: memory.enabled`);
    const autoAcceptProject = optionalBooleanField(
      table.auto_accept_project,
      `${path}: memory.auto_accept_project`,
    );
    memory = {
      ...(enabled === undefined ? {} : { enabled }),
      ...(autoAcceptProject === undefined ? {} : { autoAcceptProject }),
    };
  }
  let ui: QiUiConfig | undefined;
  if (root.ui !== undefined) {
    const table = requireTable(root.ui, `${path}: ui`);
    assertOnlyKeys(table, ["timeline_density"], `${path}: ui`);
    const timelineDensity = optionalTimelineDensityField(
      table.timeline_density,
      `${path}: ui.timeline_density`,
    );
    ui = timelineDensity === undefined ? {} : { timelineDensity };
  }
  let image: QiImageConfig | undefined;
  if (root.image !== undefined) {
    const table = requireTable(root.image, `${path}: image`);
    assertOnlyKeys(table, ["max_edge_px", "read_byte_budget"], `${path}: image`);
    const maxEdgePx = optionalIntegerField(
      table.max_edge_px,
      `${path}: image.max_edge_px`,
      256,
      8_192,
    );
    const readByteBudget = optionalIntegerField(
      table.read_byte_budget,
      `${path}: image.read_byte_budget`,
      65_536,
      4 * 1024 * 1024,
    );
    image = {
      ...(maxEdgePx === undefined ? {} : { maxEdgePx }),
      ...(readByteBudget === undefined ? {} : { readByteBudget }),
    };
  }
  return {
    version: 1,
    ...(language === undefined ? {} : { language }),
    ...(theme === undefined ? {} : { theme }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(accountAlias === undefined ? {} : { accountAlias }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(compatible === undefined ? {} : { compatible }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(outputReserveTokens === undefined ? {} : { outputReserveTokens }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxActionsPerStep === undefined ? {} : { maxActionsPerStep }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(shell === undefined ? {} : { shell }),
    ...(memory === undefined ? {} : { memory }),
    ...(ui === undefined ? {} : { ui }),
    ...(image === undefined ? {} : { image }),
  };
}

function optionalCompatibleList(value: unknown, label: string): readonly CompatibleEndpoint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of tables`);
  if (value.length === 0) return undefined;
  const seen = new Set<string>();
  const entries = value.map((entry, index) => {
    const table = requireTable(entry, `${label}[${index}]`);
    assertOnlyKeys(table, ["name", "base_url", "model", "image_input"], `${label}[${index}]`);
    const nameRaw = optionalStringField(table.name, `${label}[${index}].name`, 64);
    if (nameRaw === undefined) throw new TypeError(`${label}[${index}].name is required`);
    let name: string;
    try {
      name = normalizeAccountAlias(nameRaw);
    } catch (error) {
      throw new TypeError(`${label}[${index}].name: ${message(error)}`);
    }
    if (seen.has(name)) throw new TypeError(`${label}: duplicate name "${name}"`);
    seen.add(name);
    const baseURLRaw = optionalStringField(table.base_url, `${label}[${index}].base_url`, 2_048);
    if (baseURLRaw === undefined) throw new TypeError(`${label}[${index}].base_url is required`);
    const model = optionalStringField(table.model, `${label}[${index}].model`, 256);
    if (model === undefined) throw new TypeError(`${label}[${index}].model is required`);
    const imageInput = optionalBooleanField(table.image_input, `${label}[${index}].image_input`);
    return {
      name,
      baseURL: validateProviderBaseURL(baseURLRaw, `${label}[${index}].base_url`),
      model,
      ...(imageInput === undefined ? {} : { imageInput }),
    };
  });
  return Object.freeze(entries);
}

function optionalLanguageField(value: unknown, label: string): ConfigLanguage | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(localeIds as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be one of ${localeIds.join(", ")}`);
  }
  return value as ConfigLanguage;
}

function optionalThemeField(value: unknown, label: string): ConfigTheme | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(themeIds as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be one of ${themeIds.join(", ")}`);
  }
  return value as ConfigTheme;
}

function optionalShellProfile(value: unknown, label: string): ConfigShellProfileId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(shellProfileIds as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be one of ${shellProfileIds.join(", ")}`);
  }
  return value as ConfigShellProfileId;
}

function optionalShellProfileList(value: unknown, label: string): readonly ConfigShellProfileId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of profile names`);
  const profiles = value.map((entry, index) => {
    const profile = optionalShellProfile(entry, `${label}[${index}]`);
    if (profile === undefined) throw new TypeError(`${label}[${index}] must be a profile name`);
    return profile;
  });
  return Object.freeze([...new Set(profiles)]);
}

function booleanField(
  table: Record<string, unknown>,
  name: keyof QiCapabilityConfig,
  path: string,
): Partial<QiCapabilityConfig> {
  const value = table[name];
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new TypeError(`${path}: capabilities.${name} must be boolean`);
  return { [name]: value };
}

function optionalTimelineDensityField(
  value: unknown,
  label: string,
): ConfigTimelineDensity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(timelineDensityIds as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be one of ${timelineDensityIds.join(", ")}`);
  }
  return value as ConfigTimelineDensity;
}

function optionalBooleanField(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function requireTable(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date) {
    throw new TypeError(`${label} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(table: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(table).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function providerPersistsReasoningEffort(provider: string | undefined): boolean {
  return provider === "kimi"
    || provider === "deepseek"
    || provider === "volcengine-agent-plan"
    || provider === "qianwenai";
}

function optionalStringField(value: unknown, label: string, maximum = 128): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return normalized;
}

function optionalIntegerField(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
