import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HostProcessResult extends ProcessResult {
  timedOut: boolean;
  truncated: boolean;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string; signal?: AbortSignal }): Promise<ProcessResult>;
}

export interface HostProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  outputLimitBytes?: number;
  windowsVerbatimArguments?: boolean;
  stdin?: string | Buffer;
  detachedProcessGroup?: boolean;
  reportActivity?: (activity: {
    type: "output";
    stream: "stdout" | "stderr";
    text: string;
    truncated: boolean;
  }) => void;
}

const credentialNamePattern = /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|PRIVATE[_-]?KEY)/i;

/** Copy an environment while dropping high-confidence credential variable names. */
export function scrubCredentialEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  markers: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (credentialNamePattern.test(name)) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(markers)) {
    environment[name] = value;
  }
  return environment;
}

/** Minimal host environment for declared verification and similar trust-sensitive children. */
export function minimalHostEnvironment(
  markers: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1", ...markers };
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolveExit) => {
      killer.once("exit", () => resolveExit());
      killer.once("error", () => resolveExit());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already be gone.
    }
  }
}

export function runHostProcess(
  command: string,
  args: readonly string[],
  options: HostProcessOptions = {},
): Promise<HostProcessResult> {
  const timeoutMs = options.timeoutMs;
  const outputLimitBytes = options.outputLimitBytes ?? 64 * 1024;
  const detached = options.detachedProcessGroup ?? process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached,
      ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const current = target === "stdout" ? stdout : stderr;
      const room = Math.max(0, outputLimitBytes - Buffer.byteLength(current));
      const addition = chunk.subarray(0, room).toString("utf8");
      if (target === "stdout") stdout += addition;
      else stderr += addition;
      if (chunk.byteLength > room) truncated = true;
      options.reportActivity?.({
        type: "output",
        stream: target,
        text: target === "stdout" ? stdout : stderr,
        truncated,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child);
      }, timeoutMs);
      timer.unref();
    }

    const abort = () => {
      void terminateProcessTree(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new DOMException("Process aborted", "AbortError"));
        return;
      }
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    });
  });
}

export const hostProcessRunner: ProcessRunner = {
  async run(command, args, options = {}) {
    const result = await runHostProcess(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      env: scrubCredentialEnvironment(),
      detachedProcessGroup: false,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};
