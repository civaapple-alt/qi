import { extname, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { ToolFailure } from "@civaapple/qi-agent/tools";
import { runHostProcess, minimalHostEnvironment } from "../workspace/process.js";
import { resolveShellExecutable } from "../tools/builtins.js";
import { resolveWorkspacePath } from "../tools/workspace.js";

export interface SkillScriptRequest {
  path: string;
  args?: readonly string[];
  workdir?: string;
  timeoutMs?: number;
}

export interface SkillScriptResult {
  runtime: string;
  executable: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  stdoutFull?: string;
  stderrFull?: string;
}

export async function runSkillScript(input: {
  skillRoot: string;
  workspaceRoot: string;
  request: SkillScriptRequest;
  signal?: AbortSignal;
  reportActivity?: (activity: { type: "output"; stream: "stdout" | "stderr"; text: string; truncated: boolean }) => void;
}): Promise<SkillScriptResult> {
  const normalized = input.request.path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith("scripts/") || normalized.split("/").some((part) => part === ".." || !part)) {
    throw new ToolFailure("SKILL_SCRIPT_SCOPE", "Skill scripts must be regular files below scripts/");
  }
  const root = await realpath(input.skillRoot);
  const script = resolve(root, normalized);
  const scriptReal = await realpath(script);
  if (!scriptReal.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new ToolFailure("SKILL_SCRIPT_SCOPE", "Skill script escapes its root");
  }
  const info = await lstat(script);
  if (info.isSymbolicLink() || !info.isFile()) throw new ToolFailure("SKILL_SCRIPT_INVALID", "Skill script must be a regular non-link file");
  const workdir = await resolveWorkspacePath(input.workspaceRoot, input.request.workdir ?? ".");
  const args = [...(input.request.args ?? [])];
  if (args.length > 100 || args.some((arg) => arg.length > 8_192 || arg.includes("\0"))) {
    throw new ToolFailure("SKILL_SCRIPT_ARGUMENTS", "Skill script arguments exceed the bounded argv contract");
  }
  const invocation = await scriptInvocation(scriptReal, extname(normalized).toLowerCase(), input.workspaceRoot, args);
  const result = await runHostProcess(invocation.command, invocation.args, {
    cwd: workdir,
    timeoutMs: input.request.timeoutMs ?? 30_000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    env: minimalHostEnvironment({ QI_SKILL_ROOT: root, QI_SKILL_SCRIPT: normalized, NO_COLOR: "1" }),
    outputLimitBytes: 64 * 1024,
    captureLimitBytes: 4 * 1024 * 1024,
    ...(input.reportActivity === undefined ? {} : { reportActivity: input.reportActivity }),
  });
  const output = { runtime: invocation.runtime, executable: invocation.command, ...result };
  if (result.timedOut) throw new ToolFailure("SKILL_SCRIPT_TIMEOUT", `Skill script exceeded ${input.request.timeoutMs ?? 30_000} ms`, output);
  if (result.exitCode !== 0) throw new ToolFailure("SKILL_SCRIPT_EXIT_NONZERO", `Skill script exited with ${String(result.exitCode)}`, output);
  return output;
}

async function scriptInvocation(script: string, extension: string, workspaceRoot: string, args: string[]) {
  switch (extension) {
    case ".js": case ".mjs": case ".cjs":
      return { runtime: "node", command: process.execPath, args: [script, ...args] };
    case ".py": {
      const command = await firstExecutable(["python3", "python"], workspaceRoot);
      return { runtime: "python", command, args: [script, ...args] };
    }
    case ".sh": {
      const command = await resolveShellExecutable("bash", workspaceRoot);
      return { runtime: "bash", command, args: ["--noprofile", "--norc", script, ...args] };
    }
    case ".ps1": {
      const command = await firstExecutable(["pwsh", "powershell"], workspaceRoot);
      return { runtime: "pwsh", command, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, ...args] };
    }
    case ".cmd": case ".bat": {
      if (process.platform !== "win32") throw new ToolFailure("SKILL_SCRIPT_RUNTIME", `${extension} scripts require Windows`);
      if (args.some((arg) => /[\r\n&|<>^%!()"]/.test(arg))) throw new ToolFailure("SKILL_SCRIPT_ARGUMENTS", "Windows batch arguments contain shell metacharacters");
      const command = await resolveShellExecutable(process.env.ComSpec ?? "cmd", workspaceRoot);
      return { runtime: "cmd", command, args: ["/d", "/s", "/c", script, ...args] };
    }
    default:
      throw new ToolFailure("SKILL_SCRIPT_RUNTIME", `Unsupported Skill script type: ${extension || "<none>"}`);
  }
}

async function firstExecutable(candidates: readonly string[], workspaceRoot: string): Promise<string> {
  for (const candidate of candidates) {
    try { return await resolveShellExecutable(candidate, workspaceRoot); } catch { /* try next frozen candidate */ }
  }
  throw new ToolFailure("SKILL_SCRIPT_RUNTIME", `No supported runtime found: ${candidates.join(", ")}`);
}
