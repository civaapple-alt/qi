import { spawn } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { CodeActApi, ProgramSandbox } from "./runner.js";

export interface ContainerSandboxOptions {
  /** Path to an existing program file on disk. Exactly one of programFile/programSource is required. */
  programFile?: string;
  /** Inline ES module source (must export `async function main(api)`). The sandbox owns staging and cleanup. */
  programSource?: string;
  runtime?: "docker" | "podman";
  image?: string;
  timeoutMs?: number;
  memory?: string;
  cpus?: number;
}

export interface ContainerInvocation { command: string; args: string[] }

export function buildContainerInvocation(
  options: Omit<ContainerSandboxOptions, "programFile" | "programSource">,
  stagingDirectory: string,
): ContainerInvocation {
  const command = options.runtime ?? "docker";
  return {
    command,
    args: [
      "run", "--rm", "--network", "none", "--read-only", "--pids-limit", "64",
      "--memory", options.memory ?? "256m", "--cpus", String(options.cpus ?? 1),
      "--mount", `type=bind,src=${stagingDirectory},dst=/program,readonly`,
      options.image ?? "node:24-alpine", "node", "--input-type=module", "-e", containerWrapper("/program/program.mjs"),
    ],
  };
}

export class ContainerProgramSandbox implements ProgramSandbox {
  readonly isolation = "container" as const;
  readonly #options: ContainerSandboxOptions;

  constructor(options: ContainerSandboxOptions) {
    this.#options = options;
  }

  async run(api: CodeActApi, signal?: AbortSignal): Promise<unknown> {
    const { programFile, programSource } = this.#options;
    if ((programFile === undefined) === (programSource === undefined)) {
      throw new Error("ContainerProgramSandbox requires exactly one of programFile or programSource");
    }
    const staging = await mkdtemp(join(tmpdir(), "qi-codeact-"));
    try {
      const stagedProgram = join(staging, "program.mjs");
      if (programSource !== undefined) {
        await writeFile(stagedProgram, programSource, "utf8");
      } else {
        const program = await realpath(programFile!);
        if (!(await stat(program)).isFile()) throw new Error("CodeAct programFile must be a file");
        await copyFile(program, stagedProgram);
      }
      const runtime = this.#options.runtime ?? "docker";
      const timeoutMs = this.#options.timeoutMs ?? 60_000;
      const invocation = buildContainerInvocation(this.#options, staging);
      const child = spawn(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const spawnFailure = new Promise<never>((_resolve, reject) => child.once("error", (error) => reject(new Error(`Unable to start ${runtime} CodeAct sandbox: ${error.message}`, { cause: error }))));
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([consume(), spawnFailure]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }

      async function consume(): Promise<unknown> {
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of lines) {
          let message: ProtocolMessage;
          try {
            message = JSON.parse(line) as ProtocolMessage;
          } catch {
            throw new Error(`Container emitted non-protocol output: ${line.slice(0, 200)}`);
          }
          if (message.type === "call") {
            const result = await api.call(message.name, message.input);
            child.stdin.write(`${JSON.stringify({ type: "tool-result", callId: message.callId, result })}\n`);
          } else if (message.type === "result") {
            child.stdin.end();
            return message.output;
          } else if (message.type === "error") {
            throw new Error(`Container program failed: ${message.message}`);
          }
        }
        throw new Error(`Container exited without a result${stderr ? `: ${stderr}` : ""}`);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

type ProtocolMessage =
  | { type: "call"; callId: string; name: string; input: unknown }
  | { type: "result"; output: unknown }
  | { type: "error"; message: string };

function containerWrapper(programPath: string): string {
  return `
import readline from "node:readline";
let nextId = 1;
const waiting = new Map();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.type === "tool-result") { const pending = waiting.get(msg.callId); waiting.delete(msg.callId); pending?.(msg.result); }
});
const api = { call(name, input) {
  const callId = "call_" + nextId++;
  process.stdout.write(JSON.stringify({ type: "call", callId, name, input }) + "\\n");
  return new Promise(resolve => waiting.set(callId, resolve));
}};
try {
  const module = await import(${JSON.stringify(programPath)});
  if (typeof module.main !== "function") throw new TypeError("Program must export async function main(api)");
  const output = await module.main(api);
  process.stdout.write(JSON.stringify({ type: "result", output }) + "\\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }) + "\\n");
}
`;
}
