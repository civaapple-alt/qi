import { HostProcessSandbox } from "./host-sandbox.js";
import { probeSrtAvailable } from "./probe-srt.js";
import { SrtCliProcessSandbox } from "./srt-cli-sandbox.js";
import { ensureMachineReadableSrtWin } from "./srt-win-resolve.js";
import { SrtWinProcessSandbox } from "./srt-win-sandbox.js";
import type { ProcessSandbox, SandboxPolicy } from "./types.js";
import { WinLowIntegritySandbox } from "./win-low-il.js";

/**
 * Process-lifetime smoke successes (srt-win path or srt CLI path).
 * Avoids re-running CreateProcessWithLogon smoke on every TuiRuntime.create / test case.
 */
const smokeOkPaths = new Set<string>();

/** Test helper: drop process-level smoke cache. */
export function clearSandboxSmokeCache(): void {
  smokeOkPaths.clear();
}

export function sandboxSmokeCacheSizeForTests(): number {
  return smokeOkPaths.size;
}

export interface ResolveSandboxOptions {
  readonly policy?: SandboxPolicy;
  /**
   * Optional probe override. Default uses {@link probeSrtAvailable}.
   */
  readonly srtAvailable?: () => boolean | Promise<boolean>;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  /** Workspace used for srt settings smoke (defaults to process.cwd()). */
  readonly workspaceRoot?: string;
  /** When false, skip the short srt smoke spawn (default true when using CLI). */
  readonly smokeSrt?: boolean;
}

/**
 * Choose process sandbox backend (ADR-0041):
 * auto → (Windows) machine-readable srt-win exec → srt CLI if smoke-ok
 *      → win-low-il on Windows → host.
 */
export async function resolveSandboxBackend(
  options: ResolveSandboxOptions = {},
): Promise<ProcessSandbox> {
  const policy = options.policy ?? "auto";
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const smoke = options.smokeSrt !== false;

  if (policy === "never") {
    return new HostProcessSandbox("sandbox.policy=never; host execution forced");
  }

  const probe = await probeSrtAvailable(environment, platform);
  const srtCliOk = options.srtAvailable
    ? await options.srtAvailable()
    : probe.available && probe.kind === "cli";
  const srtPath = probe.kind === "cli" ? probe.path : undefined;

  if (policy === "low-il") {
    if (platform === "win32") return new WinLowIntegritySandbox();
    return new HostProcessSandbox("sandbox.policy=low-il is Windows-only");
  }

  // Windows preferred path: srt-win.exe from ProgramData (sandbox user can read it).
  if (platform === "win32" && srtCliOk && srtPath && (policy === "auto" || policy === "srt")) {
    const ensured = await ensureMachineReadableSrtWin(srtPath, platform);
    if (ensured) {
      const candidate = new SrtWinProcessSandbox(
        ensured.path,
        `srt-win at ${ensured.path}` +
          (ensured.copied ? ` (copied from ${ensured.source} for srt-sandbox readability)` : ""),
      );
      const accepted = await acceptAfterSmoke(candidate, ensured.path, workspaceRoot, smoke, policy);
      if (accepted) return accepted;
      // auto: fall through to CLI then low-il when smoke fails
    }
  }

  if (policy === "srt") {
    if (srtCliOk && srtPath) {
      const candidate = new SrtCliProcessSandbox(srtPath, platform);
      const accepted = await acceptAfterSmoke(candidate, srtPath, workspaceRoot, smoke, policy);
      if (accepted) return accepted;
      return new HostProcessSandbox(
        `sandbox.policy=srt but smoke failed (see prior smoke cache or re-run qi sandbox status)`,
      );
    }
    return new HostProcessSandbox(
      srtCliOk
        ? "sandbox.policy=srt: module present but srt CLI not on PATH (install srt globally)"
        : `sandbox.policy=srt but unavailable (${probe.reason})`,
    );
  }

  // auto (non-Windows or Windows after srt-win path failed)
  if (srtCliOk && srtPath && platform !== "win32") {
    const candidate = new SrtCliProcessSandbox(srtPath, platform);
    const accepted = await acceptAfterSmoke(candidate, srtPath, workspaceRoot, smoke, policy);
    if (accepted) return accepted;
    return new HostProcessSandbox(
      `srt CLI found but smoke failed; using host`,
    );
  }

  if (platform === "win32") {
    if (srtCliOk && srtPath) {
      // srt-win path failed smoke or could not copy — explain AppData issue
      const fallback = new WinLowIntegritySandbox();
      return {
        info: {
          ...fallback.info,
          reason:
            `srt is installed but full Windows isolation is not usable yet ` +
            `(CreateProcessWithLogonW/srt-win failed — often because srt-win.exe lives under ` +
            `your user profile/nvm AppData where srt-sandbox cannot read it). ` +
            `Qi tries to copy srt-win to %ProgramData%\\qi\\srt-win\\. ` +
            `Using win-low-il. Check: seclogon Running; elevated \`srt windows-install\`; ` +
            `re-run \`qi sandbox status\`.`,
        },
        run: (request) => fallback.run(request),
        wrapCommand: (request) => fallback.wrapCommand(request),
      };
    }
    return new WinLowIntegritySandbox();
  }

  return new HostProcessSandbox(`srt unavailable; ${probe.reason}`);
}

/**
 * Run smoke once per srt binary path per process. Successful smokes are cached so
 * subsequent Runtime creates (and focused tests) skip the expensive Windows logon path.
 */
async function acceptAfterSmoke(
  candidate: ProcessSandbox,
  cacheKeyPath: string,
  workspaceRoot: string,
  smoke: boolean,
  policy: SandboxPolicy,
): Promise<ProcessSandbox | undefined> {
  const key = cacheKeyPath.replace(/\//g, "\\").toLowerCase();
  if (!smoke || smokeOkPaths.has(key)) {
    return candidate;
  }
  const smokeResult = await smokeSandboxRun(candidate, workspaceRoot);
  if (smokeResult.ok) {
    smokeOkPaths.add(key);
    return candidate;
  }
  if (policy === "srt") {
    return new HostProcessSandbox(
      `sandbox.policy=srt: smoke failed: ${smokeResult.detail}`,
    );
  }
  return undefined;
}

async function smokeSandboxRun(
  sandbox: ProcessSandbox,
  workspaceRoot: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // Prefer a System32 image every account can execute — nvm's node.exe is under
  // the real user's profile and fails CreateProcessAsUserW for srt-sandbox.
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const smokeCommand =
    process.platform === "win32" ? `${systemRoot}\\System32\\cmd.exe` : process.execPath;
  const smokeArgs =
    process.platform === "win32" ? ["/c", "exit", "0"] : ["-e", "process.exit(0)"];
  try {
    const result = await sandbox.run({
      command: smokeCommand,
      args: smokeArgs,
      workspaceRoot,
      options: {
        // Smoke should fail fast; full verify later still uses tool timeouts.
        timeoutMs: 12_000,
        outputLimitBytes: 4_096,
        detachedProcessGroup: false,
      },
    });
    if (result.exitCode === 0) return { ok: true };
    const detail = (result.stderr || result.stdout || `exit ${String(result.exitCode)}`).slice(0, 500);
    return { ok: false, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message.slice(0, 500) };
  }
}
