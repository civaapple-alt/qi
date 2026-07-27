export interface LineInputBatcherOptions {
  readonly delayMs?: number;
  readonly onInput: (input: string) => void;
}

/**
 * readline emits one `line` event per pasted line. Collect adjacent events so a
 * single multi-line paste remains one user message instead of starting several
 * competing Runs.
 */
export class LineInputBatcher {
  readonly #delayMs: number;
  readonly #onInput: (input: string) => void;
  #lines: string[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LineInputBatcherOptions) {
    this.#delayMs = options.delayMs ?? 60;
    if (!Number.isFinite(this.#delayMs) || this.#delayMs < 0) {
      throw new TypeError("delayMs must be a non-negative finite number");
    }
    this.#onInput = options.onInput;
  }

  push(line: string): void {
    this.#lines.push(line);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, this.#delayMs);
  }

  flush(): string | undefined {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#lines.length === 0) return undefined;
    const input = this.#lines.join("\n");
    this.#lines = [];
    this.#onInput(input);
    return input;
  }

  cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#lines = [];
  }
}
