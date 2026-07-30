import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  runHostProcess,
  scrubCredentialEnvironment,
} from "@civaapple/qi-node/workspace";
import { ToolFailure } from "@civaapple/qi-agent/tools";
import { storeTruncatedOutputArtifact, truncatedOutputCaptureLimitBytes } from "./output-artifact.js";
import { defineTool, type AnyToolDefinition } from "@civaapple/qi-agent/tools";
import { resolveWorkspacePath } from "./workspace.js";
import {
  resolveShellExecutable,
  windowsCommandInvocation,
} from "./builtins.js";

export const SHELL_PROFILE_IDS = ["direct", "pwsh", "cmd", "bash"] as const;
export type ShellProfileId = (typeof SHELL_PROFILE_IDS)[number];
export type ScriptShellProfileId = Exclude<ShellProfileId, "direct">;

const scriptLimitBytes = 64 * 1024;
const probeTimeoutMs = 5_000;

export interface QiShellConfig {
  readonly default?: ShellProfileId;
  readonly allowed?: readonly ShellProfileId[];
}

export interface AvailableScriptProfile {
  readonly id: ScriptShellProfileId;
  readonly executable: string;
  readonly version?: string;
  readonly status: "available";
}

export interface UnavailableShellProfile {
  readonly id: ShellProfileId;
  readonly status: "unavailable" | "disallowed";
  readonly reason: string;
}

export interface ShellProfileSnapshot {
  readonly default: ShellProfileId;
  readonly allowed: readonly ShellProfileId[];
  readonly directEnabled: boolean;
  readonly available: readonly AvailableScriptProfile[];
  readonly unavailable: readonly UnavailableShellProfile[];
}

export function resolveShellConfig(
  configured: QiShellConfig | undefined,
  allowExecute: boolean,
): { default: ShellProfileId; allowed: readonly ShellProfileId[] } {
  if (!allowExecute) return { default: "direct", allowed: [] };
  const allowed = configured?.allowed ?? (["direct"] as const);
  if (allowed.length === 0) {
    throw new TypeError("shell.allowed must contain at least one profile when execute is enabled");
  }
  for (const profile of allowed) assertShellProfileId(profile, "shell.allowed");
  const defaultProfile = configured?.default ?? (allowed.includes("direct") ? "direct" : allowed[0]!);
  assertShellProfileId(defaultProfile, "shell.default");
  if (!allowed.includes(defaultProfile)) {
    throw new TypeError(`shell.default ${defaultProfile} must be listed in shell.allowed`);
  }
  return { default: defaultProfile, allowed: Object.freeze([...allowed]) };
}

/** Script profiles Qi will auto-probe for first-run defaults on this host OS. */
export function platformShellCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly ScriptShellProfileId[] {
  if (platform === "win32") return ["pwsh", "cmd"];
  return ["bash", "pwsh"];
}

/**
 * Build a first-run `[shell]` config: always enable `direct`, plus each platform candidate that
 * resolves to a trusted executable outside the Workspace.
 */
export async function detectInstalledShellProfiles(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ default: ShellProfileId; allowed: readonly ShellProfileId[] }> {
  const allowed: ShellProfileId[] = ["direct"];
  for (const id of platformShellCandidates(platform)) {
    const probed = await probeScriptProfile(id, workspaceRoot);
    if (probed.status === "available") allowed.push(id);
  }
  return {
    default: "direct",
    allowed: Object.freeze([...allowed]),
  };
}

export function shellProfileResource(profile: ShellProfileId): string {
  return `shell-profile:${profile}`;
}

export async function probeShellProfiles(
  workspaceRoot: string,
  config: { default: ShellProfileId; allowed: readonly ShellProfileId[] },
): Promise<ShellProfileSnapshot> {
  const available: AvailableScriptProfile[] = [];
  const unavailable: UnavailableShellProfile[] = [];
  const allowed = new Set(config.allowed);

  for (const id of SHELL_PROFILE_IDS) {
    if (!allowed.has(id)) {
      unavailable.push({ id, status: "disallowed", reason: "not listed in shell.allowed" });
      continue;
    }
    if (id === "direct") continue;
    const probed = await probeScriptProfile(id, workspaceRoot);
    if (probed.status === "available") available.push(probed);
    else unavailable.push(probed);
  }

  return {
    default: config.default,
    allowed: config.allowed,
    directEnabled: allowed.has("direct"),
    available: Object.freeze(available),
    unavailable: Object.freeze(unavailable),
  };
}

export function createScriptTool(profiles: readonly AvailableScriptProfile[]): AnyToolDefinition {
  const byName = new Map(profiles.map((profile) => [profile.id, profile]));
  const names = profiles.map((profile) => profile.id);
  if (names.length === 0) {
    throw new TypeError("createScriptTool requires at least one available script profile");
  }
  return defineTool({
    description:
      `Run one explicitly authorized shell-profile script (${names.join(", ")}). Prefer one script Action when you need shell builtins, pipes, or multi-statement logic; multiple shell/script Actions may share a workdir in one Step and still run sequentially. Prefer dedicated file tools for Workspace mutation. Profiles are never auto-selected from command text; choose the profile name explicitly. Same-Step file/artifact mutations still fail closed with BATCH_WRITE_CONFLICT. Non-zero exits and timeouts fail the Action.`,
    input: Type.Object(
      {
        profile: names.length === 1
          ? Type.Literal(names[0]!)
          : Type.Union(names.map((name) => Type.Literal(name))),
        script: Type.String({ minLength: 1, maxLength: scriptLimitBytes }),
        workdir: Type.Optional(Type.String({ minLength: 1 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
      },
      { additionalProperties: false },
    ),
    output: Type.Object(
      {
        profile: Type.String(),
        executable: Type.String(),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stdout: Type.String(),
        stderr: Type.String(),
        timedOut: Type.Boolean(),
        truncated: Type.Boolean(),
        outputRef: Type.Optional(Type.String({ pattern: "^artifact://[a-f0-9]{64}$" })),
      },
      { additionalProperties: false },
    ),
    effect: () => "execute",
    resources: (input) => {
      const request = input as { profile: ScriptShellProfileId; workdir?: string };
      if (!byName.has(request.profile)) {
        throw new ToolFailure("UNKNOWN_SHELL_PROFILE", `Unknown or unavailable shell profile: ${request.profile}`);
      }
      return [shellProfileResource(request.profile), `host-workspace:${request.workdir ?? "."}`];
    },
    async execute(input, context) {
      const request = input as {
        profile: ScriptShellProfileId;
        script: string;
        workdir?: string;
        timeoutMs?: number;
      };
      const profile = byName.get(request.profile);
      if (!profile) {
        throw new ToolFailure("UNKNOWN_SHELL_PROFILE", `Unknown or unavailable shell profile: ${request.profile}`);
      }
      if (Buffer.byteLength(request.script, "utf8") > scriptLimitBytes) {
        throw new ToolFailure("SCRIPT_TOO_LARGE", `Shell profile scripts are limited to ${scriptLimitBytes} bytes`);
      }
      if (request.script.includes("\0")) {
        throw new ToolFailure("INVALID_SCRIPT", "Shell profile scripts may not contain NUL bytes");
      }
      const workdir = request.workdir ?? ".";
      const cwd = await resolveWorkspacePath(context.workspaceRoot, workdir);
      if (!(await stat(cwd)).isDirectory()) {
        throw new ToolFailure("NOT_A_DIRECTORY", `${workdir} is not a directory`);
      }
      const invocation = await buildScriptInvocation(profile, request.script, context.workspaceRoot);
      try {
        const { stdoutFull, stderrFull, ...result } = await runHostProcess(invocation.command, invocation.args, {
          cwd,
          timeoutMs: request.timeoutMs ?? 30_000,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          env: scrubCredentialEnvironment(process.env, {
            QI_SHELL_PROFILE: profile.id,
            NO_COLOR: "1",
          }),
          outputLimitBytes: 64 * 1024,
          captureLimitBytes: truncatedOutputCaptureLimitBytes,
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          ...(context.reportActivity === undefined ? {} : { reportActivity: context.reportActivity }),
        });
        const artifactRef = await storeTruncatedOutputArtifact(context, { truncated: result.truncated, stdoutFull, stderrFull });
        const output = {
          profile: profile.id,
          executable: profile.executable,
          ...result,
          ...artifactRef,
        };
        if (result.timedOut) {
          throw new ToolFailure(
            "SHELL_PROFILE_TIMEOUT",
            `Shell profile ${profile.id} exceeded ${request.timeoutMs ?? 30_000} ms`,
            output,
          );
        }
        if (result.exitCode !== 0) {
          throw new ToolFailure(
            "SHELL_PROFILE_EXIT_NONZERO",
            `Shell profile ${profile.id} exited with code ${String(result.exitCode)}`,
            output,
          );
        }
        return output;
      } finally {
        if (invocation.cleanup) await invocation.cleanup();
      }
    },
  }) as AnyToolDefinition;
}

function assertShellProfileId(value: string, label: string): asserts value is ShellProfileId {
  if (!(SHELL_PROFILE_IDS as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be one of ${SHELL_PROFILE_IDS.join(", ")}`);
  }
}

async function probeScriptProfile(
  id: ScriptShellProfileId,
  workspaceRoot: string,
): Promise<AvailableScriptProfile | UnavailableShellProfile> {
  if (id === "cmd" && process.platform !== "win32") {
    return { id, status: "unavailable", reason: "cmd is only available on Windows" };
  }
  const candidates = executableCandidates(id);
  for (const candidate of candidates) {
    try {
      const executable = await resolveShellExecutable(candidate, workspaceRoot);
      if (executable.includes("/") || executable.includes("\\") || candidate !== executable) {
        // absolute or PATH-resolved trusted executable
      }
      const version = await readProfileVersion(id, executable, workspaceRoot);
      return {
        id,
        executable,
        ...(version === undefined ? {} : { version }),
        status: "available",
      };
    } catch {
      // Try the next candidate.
    }
  }
  return {
    id,
    status: "unavailable",
    reason: `no trusted ${id} executable was found outside the Workspace`,
  };
}

function executableCandidates(id: ScriptShellProfileId): readonly string[] {
  switch (id) {
    case "pwsh":
      return process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"];
    case "bash":
      return ["bash"];
    case "cmd":
      return [process.env.ComSpec || "cmd.exe"];
  }
}

async function readProfileVersion(
  id: ScriptShellProfileId,
  executable: string,
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    const invocation = id === "cmd"
      ? await windowsCommandInvocation(executable, ["/c", "ver"], workspaceRoot, "UNSAFE_SHELL_ARGUMENT")
      : id === "bash"
        ? { command: executable, args: ["--version"] as const }
        : { command: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"] as const };
    const result = await runHostProcess(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      timeoutMs: probeTimeoutMs,
      env: scrubCredentialEnvironment(process.env, { NO_COLOR: "1" }),
      outputLimitBytes: 4 * 1024,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      detachedProcessGroup: false,
    });
    if (result.exitCode !== 0) return undefined;
    const text = `${result.stdout}\n${result.stderr}`.trim();
    // cmd `ver` is OEM/ANSI-localized (e.g. 「版本」); keep an ASCII Windows build label only.
    if (id === "cmd") return formatCmdVersionLabel(text);
    const line = text.split(/\r?\n/).find((entry) => entry.trim());
    return sanitizeProfileVersion(line?.slice(0, 120));
  } catch {
    return undefined;
  }
}

/** Extract `Windows <build>` from localized/OEM `ver` output without depending on codepage decoding. */
export function formatCmdVersionLabel(text: string): string | undefined {
  const match = text.match(/(\d+\.\d+(?:\.\d+){1,2})/);
  return match ? `Windows ${match[1]}` : undefined;
}

function sanitizeProfileVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\uFFFD/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : undefined;
}

async function buildScriptInvocation(
  profile: AvailableScriptProfile,
  script: string,
  workspaceRoot: string,
): Promise<{
  command: string;
  args: readonly string[];
  stdin?: string;
  windowsVerbatimArguments?: boolean;
  cleanup?: () => Promise<void>;
}> {
  if (profile.id === "pwsh") {
    return {
      command: profile.executable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
      stdin: script,
    };
  }
  if (profile.id === "bash") {
    return {
      command: profile.executable,
      args: ["--noprofile", "--norc", "-s"],
      stdin: script,
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "qi-cmd-"));
  const scriptPath = join(directory, "script.cmd");
  await writeFile(scriptPath, script.replace(/\r?\n/g, "\r\n"), "utf8");
  const invocation = await windowsCommandInvocation(
    profile.executable,
    ["/d", "/s", "/c", scriptPath],
    workspaceRoot,
    "UNSAFE_SHELL_ARGUMENT",
  );
  return {
    command: invocation.command,
    args: invocation.args,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
