import { spawn } from "node:child_process";
import { dirname } from "node:path";
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
 * Windows full isolation via machine-readable `srt-win.exe exec`.
 *
 * Before each child, grants the sandbox user READ on the target executable
 * (and its parent dir) via `srt-win acl grant`. nvm/AppData-hosted tools
 * otherwise fail CreateProcessAsUserW with ACCESS_DENIED.
 */
export class SrtWinProcessSandbox implements ProcessSandbox {
  readonly info: SandboxBackendInfo;
  readonly #srtWinPath: string;
  #sandboxUserSid: string | undefined;
  /** Paths already granted this process lifetime (avoid re-entering srt-win acl grant). */
  readonly #grantedRead = new Set<string>();
  readonly #grantedWrite = new Set<string>();

  constructor(srtWinPath: string, detail?: string) {
    this.#srtWinPath = srtWinPath;
    this.info = {
      backend: "srt-windows",
      strength: "full",
      status: "active",
      reason:
        detail
        ?? `Wrapping children with srt-win exec at ${srtWinPath} (machine-readable + acl grant for tool paths)`,
      wraps: [...DEFAULT_SANDBOX_WRAPS],
    };
  }

  async run(request: SandboxSpawnRequest) {
    await this.#prepareAccess(request.command, request.workspaceRoot, request.readOnlyRoots);
    const wrapped = this.#wrap(request.command, request.args, request.options?.env);
    return runHostProcess(wrapped.command, wrapped.args, {
      ...request.options,
      env: wrapped.env,
      cwd: request.options?.cwd ?? request.workspaceRoot,
      detachedProcessGroup: false,
    });
  }

  async wrapCommand(request: SandboxWrapRequest): Promise<SandboxCommandWrap> {
    await this.#prepareAccess(request.command, request.workspaceRoot, request.readOnlyRoots);
    const wrapped = this.#wrap(request.command, request.args, request.env);
    return {
      command: wrapped.command,
      args: wrapped.args,
      env: stringEnv(wrapped.env),
    };
  }

  /**
   * Warm ACL grants for common tool binaries (e.g. process.execPath) so the first
   * shell/verify does not pay a multi-second cold grant spike mid-Run.
   */
  async prewarm(options: {
    readonly commands: readonly string[];
    readonly workspaceRoot: string;
    readonly readOnlyRoots?: readonly string[];
  }): Promise<void> {
    const commands = options.commands.length > 0 ? options.commands : [];
    for (const command of commands) {
      await this.#prepareAccess(command, options.workspaceRoot, options.readOnlyRoots);
    }
    // Ensure workspace write ACE is granted even when command list is empty.
    if (commands.length === 0) {
      await this.#prepareAccess(options.workspaceRoot, options.workspaceRoot, options.readOnlyRoots);
    }
  }

  async #prepareAccess(
    command: string,
    workspaceRoot: string,
    readOnlyRoots?: readonly string[],
  ): Promise<void> {
    // System images are already world-readable/executable — acl grant on System32 fails (needs admin SD).
    // Grant the tool + a short ancestor chain so Node realpath under nvm/AppData can walk the path
    // without flooding srt-win with dozens of roots (that previously hung acl grant).
    const readCandidates = uniquePaths([
      command,
      ...ancestorDirectories(command, 6),
      workspaceRoot,
      ...(readOnlyRoots ?? []),
    ]).filter((path) => needsSandboxAclGrant(path));
    const writeCandidates = uniquePaths([workspaceRoot]).filter((path) => needsSandboxAclGrant(path));
    const read = readCandidates.filter((path) => !this.#grantedRead.has(pathKey(path)));
    const write = writeCandidates.filter((path) => !this.#grantedWrite.has(pathKey(path)));
    if (read.length === 0 && write.length === 0) return;
    try {
      await this.#aclGrant(read, write);
      for (const path of read) this.#grantedRead.add(pathKey(path));
      for (const path of write) this.#grantedWrite.add(pathKey(path));
    } catch {
      // Non-fatal: exec may still succeed for already-world-readable targets.
    }
  }

  async #aclGrant(read: readonly string[], write: readonly string[]): Promise<void> {
    const sid = await this.#resolveSandboxUserSid();
    if (!sid) return;
    if (read.length === 0 && write.length === 0) return;
    const body = JSON.stringify({ read: [...read], write: [...write] });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.#srtWinPath,
        ["acl", "grant", "--holder-pid", String(process.pid), "--sandbox-user-sid", sid],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      // srt-win acl grant can stall on large path sets; never block the tool forever.
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish(new Error("srt-win acl grant timed out after 12s"));
      }, 12_000);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      child.stdin?.end(body);
      child.on("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(`srt-win acl grant failed (exit ${String(code)}): ${stderr.slice(0, 300)}`));
      });
    });
  }

  async #resolveSandboxUserSid(): Promise<string | undefined> {
    if (this.#sandboxUserSid) return this.#sandboxUserSid;
    try {
      const result = await runHostProcess(this.#srtWinPath, ["user", "status"], {
        timeoutMs: 10_000,
        outputLimitBytes: 16_384,
        detachedProcessGroup: false,
      });
      if (result.exitCode !== 0) return undefined;
      const parsed = JSON.parse(result.stdout) as {
        user?: { sid?: string };
        marker_user_sid?: string;
      };
      const sid = parsed.user?.sid ?? parsed.marker_user_sid;
      if (sid) this.#sandboxUserSid = sid;
      return sid;
    } catch {
      return undefined;
    }
  }

  #wrap(
    command: string,
    args: readonly string[],
    baseEnv: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined,
  ): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const env: NodeJS.ProcessEnv = {
      ...(baseEnv as NodeJS.ProcessEnv | undefined ?? process.env),
      QI_SANDBOX_BACKEND: "srt-windows",
    };
    return {
      command: this.#srtWinPath,
      args: ["exec", "--quiet", "--", command, ...args],
      env,
    };
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function pathKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/** Parent directories from path up to (not including) the drive/root. Cap depth for safety. */
function ancestorDirectories(path: string, maxDepth = 6): string[] {
  const out: string[] = [];
  let cursor = path.replace(/\//g, "\\");
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = dirname(cursor);
    if (!parent || parent === cursor) break;
    // Stop at drive roots like C:\
    if (/^[A-Za-z]:\\?$/.test(parent) || parent === "\\") break;
    // Stop before flooding grants for every home directory prefix.
    if (/^[A-Za-z]:\\users$/i.test(parent)) break;
    out.push(parent);
    cursor = parent;
  }
  return out;
}

/** Paths that typically need an explicit ALLOW ACE for srt-sandbox (user profile / project). */
function needsSandboxAclGrant(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  if (normalized.includes("\\windows\\system32") || normalized.includes("\\windows\\syswow64")) {
    return false;
  }
  if (normalized.startsWith("c:\\program files") || normalized.startsWith("c:\\program files (x86)")) {
    return false;
  }
  // ProgramData\\qi\\srt-win is already shared; skip.
  if (normalized.includes("\\programdata\\qi\\srt-win")) return false;
  return true;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
