import {
  parseModelEvent,
  parseModelRequest,
  type ModelCapabilities,
  type ModelEvent,
  type ModelPort,
  type ModelRef,
  type ModelRequest,
} from "./model.js";

export type ModelScript = readonly ModelEvent[] | ((request: ModelRequest) => readonly ModelEvent[]);

const defaultCapabilities: ModelCapabilities = {
  input: new Set(["text", "image", "artifact"]),
  output: new Set(["text", "reasoning", "action"]),
  contextTokens: 128_000,
  parallelActions: true,
  promptCache: false,
};

export class ScriptedModelPort implements ModelPort {
  readonly #scripts: ModelScript[];
  readonly #capabilities: ModelCapabilities;
  readonly requests: ModelRequest[] = [];

  constructor(scripts: readonly ModelScript[] = [], capabilities: ModelCapabilities = defaultCapabilities) {
    this.#scripts = [...scripts];
    this.#capabilities = capabilities;
  }

  enqueue(script: ModelScript): void {
    this.#scripts.push(script);
  }

  async capabilities(_model: ModelRef): Promise<ModelCapabilities> {
    return {
      ...this.#capabilities,
      input: new Set(this.#capabilities.input),
      output: new Set(this.#capabilities.output),
    };
  }

  async *stream(rawRequest: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const request = parseModelRequest(rawRequest);
    this.#throwIfAborted(signal);
    const script = this.#scripts.shift();
    if (!script) throw new Error(`No scripted model response is available for ${request.requestId}`);

    this.requests.push(structuredClone(request));
    const events = typeof script === "function" ? script(request) : script;
    let terminal = false;

    for (const rawEvent of events) {
      this.#throwIfAborted(signal);
      if (terminal) throw new Error("A model script cannot emit events after a terminal event");
      const event = parseModelEvent(rawEvent);
      terminal = event.type === "completed" || event.type === "failed";
      yield structuredClone(event);
      await Promise.resolve();
    }

    if (!terminal) throw new Error("A model script must end with completed or failed");
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason ?? new DOMException("The model request was aborted", "AbortError");
  }
}
