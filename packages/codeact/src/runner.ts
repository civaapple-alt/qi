import type { CodeActCallResult, ControlledToolClient } from "./controlled-client.js";

export interface CodeActApi {
  call(name: string, input: unknown): Promise<CodeActCallResult>;
}

export interface ProgramSandbox {
  readonly isolation: "fixture" | "container";
  run(api: CodeActApi, signal?: AbortSignal): Promise<unknown>;
}

export class CodeActRunner {
  readonly #client: ControlledToolClient;

  constructor(client: ControlledToolClient) {
    this.#client = client;
  }

  run(sandbox: ProgramSandbox, signal?: AbortSignal): Promise<unknown> {
    return sandbox.run({ call: (name, input) => this.#client.call(name, input) }, signal);
  }
}

/** Deterministic in-process fixture. It is deliberately not represented as a security sandbox. */
export class FixtureProgramSandbox implements ProgramSandbox {
  readonly isolation = "fixture" as const;
  readonly #program: (api: CodeActApi) => Promise<unknown>;

  constructor(program: (api: CodeActApi) => Promise<unknown>) {
    this.#program = program;
  }

  run(api: CodeActApi, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    return this.#program(api);
  }
}
