import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runHostProcess } from "../workspace/process.js";
import type {
  ProcessSandbox,
  SandboxBackendInfo,
  SandboxCommandWrap,
  SandboxSpawnRequest,
  SandboxWrapRequest,
} from "./types.js";
import { DEFAULT_SANDBOX_WRAPS } from "./types.js";

/**
 * Wrap children with the Anthropic `srt` CLI when present on PATH (ADR-0041).
 * Uses a per-workspace settings file so write is limited to the Workspace by default.
 *
 * On Windows, `srt` is often an npm `.cmd` shim. Node cannot spawn `.cmd` directly (EINVAL);
 * we invoke it through the trusted `ComSpec` the same way shell tools wrap `npm.cmd`.
 */
export class SrtCliProcessSandbox implements ProcessSandbox {
  readonly info: SandboxBackendInfo;
  readonly #srtPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #settingsPathByWorkspace = new Map<string, string>();

  constructor(srtPath: string, platform: NodeJS.Platform = process.platform) {
    const backend =
      platform === "darwin" ? "srt-macos" : platform === "win32" ? "srt-windows" : "srt-linux";
    this.#srtPath = srtPath;
    this.#platform = platform;
    this.info = {
      backend,
      strength: "full",
      status: "active",
      reason: `Wrapping children with srt CLI at ${srtPath}`,
      wraps: [...DEFAULT_SANDBOX_WRAPS],
    };
  }

  async run(request: SandboxSpawnRequest) {
    const settings = await this.#ensureSettings(request.workspaceRoot, request.readOnlyRoots);
    const wrapped = this.#wrap(request.command, request.args, request.options?.env, settings);
    return runHostProcess(wrapped.command, wrapped.args, {
      ...request.options,
      env: wrapped.env,
      cwd: request.options?.cwd ?? request.workspaceRoot,
      ...(wrapped.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  }

  async wrapCommand(request: SandboxWrapRequest): Promise<SandboxCommandWrap> {
    const settings = await this.#ensureSettings(request.workspaceRoot, request.readOnlyRoots);
    const wrapped = this.#wrap(request.command, request.args, request.env, settings);
    return {
      command: wrapped.command,
      args: wrapped.args,
      env: stringEnv(wrapped.env),
      ...(wrapped.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    };
  }

  #wrap(
    command: string,
    args: readonly string[],
    baseEnv: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined,
    settingsPath: string,
  ): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    windowsVerbatimArguments?: boolean;
  } {
    const env: NodeJS.ProcessEnv = {
      ...(baseEnv as NodeJS.ProcessEnv | undefined ?? process.env),
      QI_SANDBOX_BACKEND: this.info.backend,
    };
    // srt CLI: srt -s <settings> <command> [args...]
    const srtArgs = ["-s", settingsPath, command, ...args];

    if (this.#platform === "win32" && /\.(cmd|bat)$/i.test(this.#srtPath)) {
      // Node 20+ rejects spawn of .cmd without shell (EINVAL). Use ComSpec like npm.cmd tools.
      const comSpec = process.env.ComSpec || "cmd.exe";
      const commandLine = [`"${this.#srtPath}"`, ...srtArgs.map((argument) => `"${argument}"`)].join(" ");
      return {
        command: comSpec,
        args: ["/d", "/s", "/c", `"${commandLine}"`],
        env,
        windowsVerbatimArguments: true,
      };
    }

    return {
      command: this.#srtPath,
      args: srtArgs,
      env,
    };
  }

  async #ensureSettings(workspaceRoot: string, readOnlyRoots?: readonly string[]): Promise<string> {
    const cached = this.#settingsPathByWorkspace.get(workspaceRoot);
    if (cached) return cached;
    const dir = join(workspaceRoot, ".qi-sandbox");
    await mkdir(dir, { recursive: true });
    const settingsPath = join(dir, "srt-settings.json");
    const allowRead = [workspaceRoot, ...(readOnlyRoots ?? [])];
    // Windows: allow common temp roots; srt denyRead still blocks host secret dirs.
    const allowWrite = [
      workspaceRoot,
      join(workspaceRoot, ".qi-sandbox"),
      ...(this.#platform === "win32"
        ? [process.env.TEMP, process.env.TMP].filter((value): value is string => Boolean(value))
        : ["/tmp"]),
    ];
    const body = {
      network: {
        allowedDomains: [] as string[],
        deniedDomains: [] as string[],
      },
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        allowRead,
        allowWrite,
        denyWrite: [".env", "**/.env", "**/.env.*"],
      },
    };
    await writeFile(settingsPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    this.#settingsPathByWorkspace.set(workspaceRoot, settingsPath);
    return settingsPath;
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
