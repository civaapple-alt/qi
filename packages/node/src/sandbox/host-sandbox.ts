import { runHostProcess } from "../workspace/process.js";
import type {
  ProcessSandbox,
  SandboxBackendInfo,
  SandboxCommandWrap,
  SandboxSpawnRequest,
  SandboxWrapRequest,
} from "./types.js";
import { DEFAULT_SANDBOX_WRAPS } from "./types.js";

/** Honest host execution with explicit disclosure (ADR-0041 final fallback). */
export class HostProcessSandbox implements ProcessSandbox {
  readonly info: SandboxBackendInfo;

  constructor(reason = "No OS sandbox backend available; running as host process") {
    this.info = {
      backend: "host",
      strength: "none",
      status: "unavailable",
      reason,
      wraps: [...DEFAULT_SANDBOX_WRAPS],
    };
  }

  run(request: SandboxSpawnRequest) {
    return runHostProcess(request.command, request.args, request.options);
  }

  wrapCommand(request: SandboxWrapRequest): SandboxCommandWrap {
    return {
      command: request.command,
      args: request.args,
      ...(request.env === undefined ? {} : { env: { ...request.env } }),
    };
  }
}
