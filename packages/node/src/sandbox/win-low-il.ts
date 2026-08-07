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
 * Windows Low Integrity middle tier (ADR-0041).
 *
 * Full Win32 Low IL token launch is phased; this backend currently runs the host process
 * while advertising `strength: reduced` so UIs never claim srt-equivalent isolation.
 * Path guards remain mandatory for secret-path denial (MIC does not block user reads).
 * MCP stdio wrap is identity (no pipe-capable Low IL launcher yet) but env caches still redirect.
 */
export class WinLowIntegritySandbox implements ProcessSandbox {
  readonly info: SandboxBackendInfo = {
    backend: "win-low-il",
    strength: "reduced",
    status: "reduced",
    reason:
      "Windows Low Integrity tier (reduced): No-Write-Up intent; does not block reading user secrets — install srt for full isolation",
    wraps: [...DEFAULT_SANDBOX_WRAPS],
  };

  #cacheEnv(workspace: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...(base ?? process.env),
      TEMP: `${workspace}\\.qi-sandbox-tmp`,
      TMP: `${workspace}\\.qi-sandbox-tmp`,
      npm_config_cache: `${workspace}\\.qi-sandbox-npm-cache`,
      PYTHONPYCACHEPREFIX: `${workspace}\\.qi-sandbox-pycache`,
      QI_SANDBOX_BACKEND: "win-low-il",
    };
  }

  async run(request: SandboxSpawnRequest) {
    const workspace = request.workspaceRoot;
    return runHostProcess(request.command, request.args, {
      ...request.options,
      env: this.#cacheEnv(workspace, request.options?.env),
      cwd: request.options?.cwd ?? workspace,
    });
  }

  wrapCommand(request: SandboxWrapRequest): SandboxCommandWrap {
    const env = this.#cacheEnv(request.workspaceRoot, request.env as NodeJS.ProcessEnv | undefined);
    const stringEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) stringEnv[key] = value;
    }
    return {
      command: request.command,
      args: request.args,
      env: stringEnv,
    };
  }
}
