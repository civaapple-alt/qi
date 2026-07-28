import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HostProcessResult extends ProcessResult {
  timedOut: boolean;
  truncated: boolean;
  /**
   * Present only when the run was truncated (stdout/stderr exceeded outputLimitBytes) and the caller opted
   * into a larger captureLimitBytes: the complete stdout/stderr up to that ceiling, for callers that want to
   * store the full output as a retrievable Artifact instead of discarding it. Omitted whenever
   * captureLimitBytes was left at its default (equal to outputLimitBytes), so existing callers see no change.
   */
  stdoutFull?: string;
  stderrFull?: string;
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
  /**
   * Independent ceiling for capturing complete stdout/stderr beyond outputLimitBytes. Defaults to
   * outputLimitBytes (i.e. no extra capture, matching prior behavior). Only the overflow above
   * outputLimitBytes is buffered up to this ceiling, so well-behaved processes pay no extra memory cost.
   */
  captureLimitBytes?: number;
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
const ambientPackageManagerVariables = new Set([
  "npm_config_allow_scripts",
]);

function detectProcessOutputEncoding(chunk: Buffer): BufferEncoding {
  if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) return "utf16le";
  const sampleLength = Math.min(chunk.length - (chunk.length % 2), 256);
  const pairs = sampleLength / 2;
  if (pairs < 4) return "utf8";
  let oddNuls = 0;
  let evenNuls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (chunk[index] === 0) evenNuls += 1;
    if (chunk[index + 1] === 0) oddNuls += 1;
  }
  return oddNuls >= Math.max(2, Math.ceil(pairs * 0.25)) && oddNuls > evenNuls * 2
    ? "utf16le"
    : "utf8";
}

function normalizeProcessOutputChunk(chunk: Buffer, encoding: BufferEncoding): Buffer {
  if (encoding === "utf8") return chunk;
  return Buffer.from(chunk.toString(encoding).replace(/^\ufeff/, ""), "utf8");
}

/**
 * Copy a host environment while dropping high-confidence credential names and package-manager settings that
 * npm exports into lifecycle children. In particular, inheriting `npm_config_allow_scripts` from `npm run qi`
 * makes a nested project-scoped npm install misinterpret the launcher's policy as an explicit CLI/env override.
 * The nested npm process still reads its ordinary project, user, and global configuration files.
 */
export function scrubCredentialEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  markers: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const disablesColor = Object.keys(markers).some((name) => name.toUpperCase() === "NO_COLOR");
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (credentialNamePattern.test(name)) continue;
    if (ambientPackageManagerVariables.has(name.toLowerCase())) continue;
    if (disablesColor && name.toUpperCase() === "FORCE_COLOR") continue;
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
  const captureLimitBytes = Math.max(outputLimitBytes, options.captureLimitBytes ?? outputLimitBytes);
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
    let stdoutOverflow = "";
    let stderrOverflow = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let stdoutEncoding: BufferEncoding | undefined;
    let stderrEncoding: BufferEncoding | undefined;

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const isStdout = target === "stdout";
      const encoding = isStdout
        ? (stdoutEncoding ??= detectProcessOutputEncoding(chunk))
        : (stderrEncoding ??= detectProcessOutputEncoding(chunk));
      const normalizedChunk = normalizeProcessOutputChunk(chunk, encoding);
      const current = isStdout ? stdout : stderr;
      const room = Math.max(0, outputLimitBytes - Buffer.byteLength(current));
      const addition = normalizedChunk.subarray(0, room).toString("utf8");
      if (isStdout) stdout += addition;
      else stderr += addition;
      const remainder = normalizedChunk.subarray(room);
      if (remainder.byteLength > 0) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        if (captureLimitBytes > outputLimitBytes) {
          const overflow = isStdout ? stdoutOverflow : stderrOverflow;
          const overflowRoom = Math.max(0, captureLimitBytes - outputLimitBytes - Buffer.byteLength(overflow));
          const overflowAddition = remainder.subarray(0, overflowRoom).toString("utf8");
          if (isStdout) stdoutOverflow += overflowAddition;
          else stderrOverflow += overflowAddition;
        }
      }
      options.reportActivity?.({
        type: "output",
        stream: target,
        text: isStdout ? stdout : stderr,
        truncated: stdoutTruncated || stderrTruncated,
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
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
        ...(stdoutTruncated && captureLimitBytes > outputLimitBytes ? { stdoutFull: stdout + stdoutOverflow } : {}),
        ...(stderrTruncated && captureLimitBytes > outputLimitBytes ? { stderrFull: stderr + stderrOverflow } : {}),
      });
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
