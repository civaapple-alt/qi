import { resolve } from "node:path";
import { hostProcessRunner, type ProcessResult, type ProcessRunner } from "./process.js";

export interface ContainerRunRequest {
  image: string;
  workspaceRoot: string;
  command: string;
  args: readonly string[];
  writableWorkspace?: boolean;
  network?: "none" | "bridge";
  signal?: AbortSignal;
}

export class ContainerWorkspaceAdapter {
  readonly runtime: "docker" | "podman";
  readonly #runner: ProcessRunner;

  constructor(runtime: "docker" | "podman", runner: ProcessRunner = hostProcessRunner) {
    this.runtime = runtime;
    this.#runner = runner;
  }

  async available(): Promise<boolean> {
    const result = await this.#runner.run(this.runtime, ["version", "--format", "{{.Server.Version}}"]).catch(() => undefined);
    return result?.exitCode === 0;
  }

  plan(request: ContainerRunRequest): { command: string; args: string[] } {
    if (!request.image || !request.command) throw new TypeError("Container image and command are required");
    const mount = `type=bind,src=${resolve(request.workspaceRoot)},dst=/workspace${request.writableWorkspace ? "" : ",readonly"}`;
    return {
      command: this.runtime,
      args: [
        "run",
        "--rm",
        "--network",
        request.network ?? "none",
        "--read-only",
        "--mount",
        mount,
        "--workdir",
        "/workspace",
        request.image,
        request.command,
        ...request.args,
      ],
    };
  }

  async run(request: ContainerRunRequest): Promise<ProcessResult> {
    if (!(await this.available())) throw new Error(`${this.runtime} daemon is unavailable; no sandbox was started`);
    const plan = this.plan(request);
    return this.#runner.run(plan.command, plan.args, request.signal === undefined ? {} : { signal: request.signal });
  }
}
