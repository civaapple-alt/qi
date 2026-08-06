import { resolve } from "node:path";
import { defaultQiHome, projectPaths } from "@civaapple/qi-node/paths";
import {
  defaultUserConfigPath,
  loadUserConfig,
  resolveDelegateConfig,
  resolveLanguage,
  resolveTheme,
  resolveTimelineDensity,
  type LoadedUserConfig,
  type QiUserConfig,
} from "./config.js";
import {
  loadProjectConfig,
  mergeCapabilities,
  projectConfigPathForWorkspace,
  type LoadedProjectConfig,
} from "./project-config.js";
import { missingDiscoveryAccelerators } from "./discovery-tools.js";
import { qiCliVersion } from "./cli.js";
import { TUI_DEFAULT_MAX_ACTIONS_PER_STEP, TUI_DEFAULT_MAX_STEPS } from "./runtime.js";

/**
 * Non-interactive configuration inspection.
 * Usage: qi config show|validate [--workspace PATH] [--json]
 */
export async function runConfigCliCommand(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly write?: (text: string) => void;
    readonly writeErr?: (text: string) => void;
    readonly packageVersion?: string;
  } = {},
): Promise<boolean> {
  if (argv[0] !== "config") return false;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const { operation, workspace, json, configPath } = parseConfigArgs(argv.slice(1), cwd);

  if (operation !== "show" && operation !== "validate" && operation !== "doctor") {
    throw new TypeError("Usage: qi config show|validate|doctor [--workspace PATH] [--config PATH] [--json]");
  }

  try {
    const report = await buildConfigReport({
      workspaceRoot: workspace,
      environment,
      ...(configPath === undefined ? {} : { configPath }),
      ...(options.packageVersion === undefined ? {} : { packageVersion: options.packageVersion }),
    });
    if (operation === "validate") {
      write(json
        ? `${JSON.stringify({ ok: true, userConfig: report.user.path, projectConfig: report.project.path }, null, 2)}\n`
        : `OK\nuser ${report.user.path}${report.user.exists ? "" : " (missing · defaults)"}\nproject ${report.project.path}${report.project.exists ? "" : " (missing · defaults)"}\n`);
      return true;
    }
    if (operation === "doctor") {
      write(json ? `${JSON.stringify(report.doctor, null, 2)}\n` : `${report.doctor.lines.join("\n")}\n`);
      if (report.doctor.issues > 0) process.exitCode = 1;
      return true;
    }
    write(json ? `${JSON.stringify(report.effective, null, 2)}\n` : `${formatEffectiveHuman(report)}\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      writeErr(`${message}\n`);
    }
    process.exitCode = 1;
    return true;
  }
}

export interface ConfigReport {
  readonly user: LoadedUserConfig;
  readonly project: LoadedProjectConfig;
  readonly effective: Record<string, unknown>;
  readonly doctor: {
    readonly issues: number;
    readonly lines: readonly string[];
    readonly checks: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[];
  };
}

export async function buildConfigReport(options: {
  readonly workspaceRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly packageVersion?: string;
}): Promise<ConfigReport> {
  const environment = options.environment ?? process.env;
  const userPath = options.configPath ?? defaultUserConfigPath(environment);
  const user = await loadUserConfig(userPath);
  const projectPath = projectConfigPathForWorkspace(options.workspaceRoot, environment);
  const project = await loadProjectConfig(projectPath);
  const resolvedCaps = mergeCapabilities(user.config.capabilities, project.config.capabilities, {});
  const capabilities = {
    write: resolvedCaps.allowWrite,
    verify: resolvedCaps.allowVerify,
    network: resolvedCaps.allowNetwork,
    execute: resolvedCaps.allowExecute,
    background: resolvedCaps.allowBackground,
    delegate: resolvedCaps.allowDelegate,
    publish: resolvedCaps.allowPublish,
    spend: resolvedCaps.allowSpend,
  };
  const paths = projectPaths({ workspaceRoot: options.workspaceRoot, environment });
  const missing = await missingDiscoveryAccelerators(options.workspaceRoot);
  const delegate = resolveDelegateConfig(user.config.delegate);

  const effective = {
    version: qiCliVersion(options.packageVersion),
    workspace: options.workspaceRoot,
    qiHome: paths.qiHome ?? defaultQiHome(environment),
    dataRoot: paths.root,
    projectId: paths.projectId,
    userConfig: {
      path: user.path,
      exists: user.exists,
    },
    projectConfig: {
      path: project.path,
      exists: project.exists,
    },
    language: resolveLanguage(user.config),
    theme: resolveTheme(user.config),
    timelineDensity: resolveTimelineDensity(user.config),
    provider: user.config.provider ?? null,
    model: user.config.model ?? null,
    accountAlias: user.config.accountAlias ?? null,
    baseURL: user.config.baseURL ?? null,
    // Never emit secrets — only routing defaults from TOML.
    reasoningEffort: user.config.reasoningEffort ?? null,
    contextWindowTokens: user.config.contextWindowTokens ?? null,
    outputReserveTokens: user.config.outputReserveTokens ?? null,
    maxSteps: project.config.maxSteps ?? user.config.maxSteps ?? TUI_DEFAULT_MAX_STEPS,
    maxActionsPerStep: user.config.maxActionsPerStep ?? TUI_DEFAULT_MAX_ACTIONS_PER_STEP,
    capabilities,
    shell: user.config.shell ?? null,
    memory: {
      enabled: user.config.memory?.enabled ?? true,
      autoAcceptProject: user.config.memory?.autoAcceptProject ?? true,
    },
    delegate,
    tools: {
      qiSessionInspect: user.config.tools?.qiSessionInspect === true,
    },
    mounts: project.config.mounts ?? [],
  };

  const checks: { id: string; ok: boolean; detail: string }[] = [
    {
      id: "user-config",
      ok: true,
      detail: user.exists ? `valid ${user.path}` : `missing ${user.path} · using defaults`,
    },
    {
      id: "project-config",
      ok: true,
      detail: project.exists ? `valid ${project.path}` : `missing ${project.path} · using defaults`,
    },
    {
      id: "provider-routing",
      ok: user.config.provider !== undefined || !user.exists,
      detail: user.config.provider
        ? `provider ${user.config.provider}${user.config.model ? ` / ${user.config.model}` : ""}`
        : "no provider in user config (env /login still works)",
    },
    {
      id: "discovery-accelerators",
      ok: missing.length === 0,
      detail: missing.length === 0
        ? "rg and fd available on PATH (or not required)"
        : `missing on PATH: ${missing.join(", ")} (Node fallback remains active)`,
    },
  ];
  const issues = checks.filter((check) => !check.ok).length;
  const lines = [
    `Qi doctor · ${effective.version}`,
    `workspace ${options.workspaceRoot}`,
    ...checks.map((check) => `${check.ok ? "ok" : "!!"}  ${check.id} · ${check.detail}`),
    issues === 0 ? "No blocking issues." : `${issues} issue(s) — see details above.`,
  ];

  return { user, project, effective, doctor: { issues, lines, checks } };
}

export function formatAboutLines(input: {
  readonly version: string;
  readonly platform: string;
  readonly node: string;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly mode?: string;
  readonly authStatus?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly dataRoot?: string;
}): string[] {
  return [
    `Qi ${input.version.replace(/^qi\s+/i, "")}`,
    `platform ${input.platform} · node ${input.node}`,
    `workspace ${input.workspace}`,
    ...(input.sessionId === undefined ? [] : [`session ${input.sessionId}`]),
    ...(input.mode === undefined ? [] : [`mode ${input.mode}`]),
    ...(input.authStatus === undefined
      ? []
      : [`auth ${input.authStatus}${input.provider ? ` · ${input.provider}` : ""}${input.model ? `/${input.model}` : ""}`]),
    ...(input.userConfigPath === undefined ? [] : [`user config ${input.userConfigPath}`]),
    ...(input.projectConfigPath === undefined ? [] : [`project policy ${input.projectConfigPath}`]),
    ...(input.dataRoot === undefined ? [] : [`data ${input.dataRoot}`]),
  ];
}

function formatEffectiveHuman(report: ConfigReport): string {
  const e = report.effective;
  const caps = e.capabilities as Record<string, boolean>;
  const enabled = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
  const disabled = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
  return [
    `Qi config (effective, secrets omitted)`,
    `workspace ${e.workspace}`,
    `user ${report.user.path}${report.user.exists ? "" : " (defaults)"}`,
    `project ${report.project.path}${report.project.exists ? "" : " (defaults)"}`,
    `language ${e.language} · theme ${e.theme} · density ${e.timelineDensity}`,
    `provider ${e.provider ?? "—"} · model ${e.model ?? "—"}`,
    `maxSteps ${e.maxSteps} · maxActionsPerStep ${e.maxActionsPerStep}`,
    `capabilities on: ${enabled.join(", ") || "none"}`,
    `capabilities off: ${disabled.join(", ") || "none"}`,
    `memory enabled=${(e.memory as { enabled: boolean }).enabled} auto_accept_project=${(e.memory as { autoAcceptProject: boolean }).autoAcceptProject}`,
    `delegate wall=${(e.delegate as { wallTimeMs: number }).wallTimeMs}ms steps%=${(e.delegate as { maxStepsPercent: number }).maxStepsPercent} context%=${(e.delegate as { contextTokensPercent: number }).contextTokensPercent}`,
  ].join("\n");
}

function parseConfigArgs(argv: readonly string[], cwd: string): {
  operation: string;
  workspace: string;
  json: boolean;
  configPath?: string;
} {
  let operation = "show";
  let workspace = cwd;
  let json = false;
  let configPath: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--workspace") {
      const value = argv[++index];
      if (!value) throw new TypeError("--workspace requires a path");
      workspace = resolve(cwd, value);
      continue;
    }
    if (arg === "--config") {
      const value = argv[++index];
      if (!value) throw new TypeError("--config requires a path");
      configPath = resolve(cwd, value);
      continue;
    }
    if (arg.startsWith("-")) throw new TypeError(`Unknown config option: ${arg}`);
    positionals.push(arg);
  }
  if (positionals.length > 1) throw new TypeError("Usage: qi config show|validate|doctor …");
  if (positionals[0]) operation = positionals[0]!.toLowerCase();
  return {
    operation,
    workspace,
    json,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

/** Redacted snapshot of a user config for panels (no secrets ever stored in TOML). */
export function summarizeUserConfig(config: QiUserConfig): Record<string, unknown> {
  return {
    version: config.version,
    language: config.language,
    theme: config.theme,
    provider: config.provider,
    model: config.model,
    accountAlias: config.accountAlias,
    baseURL: config.baseURL,
    reasoningEffort: config.reasoningEffort,
    contextWindowTokens: config.contextWindowTokens,
    outputReserveTokens: config.outputReserveTokens,
    maxSteps: config.maxSteps,
    maxActionsPerStep: config.maxActionsPerStep,
    capabilities: config.capabilities,
    shell: config.shell,
    memory: config.memory,
    ui: config.ui,
    delegate: config.delegate,
    tools: config.tools,
  };
}
