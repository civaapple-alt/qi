import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { panelFooter, panelHeader } from "./chrome.js";
import type { PanelComponent } from "./types.js";

export interface FormField {
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string;
  /** Prefill the input (e.g. profile default model). */
  readonly initialValue?: string;
  readonly secret?: boolean;
  readonly required?: boolean;
}

export interface FormPanelOptions {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly FormField[];
  readonly submitLabel?: string;
  readonly onSubmit: (values: Readonly<Record<string, string>>) => void;
  readonly onClose: () => void;
}

/** Multi-field form: Tab/↑↓ switch fields, Enter advances or submits, Esc cancels. */
export class FormPanel implements PanelComponent, Focusable {
  readonly title: string;
  focused = false;
  readonly #description: string | undefined;
  readonly #fields: readonly FormField[];
  readonly #submitLabel: string;
  readonly #onSubmit: (values: Readonly<Record<string, string>>) => void;
  readonly #onClose: () => void;
  readonly #inputs: Input[];
  #index = 0;
  #error: string | undefined;

  constructor(options: FormPanelOptions) {
    this.title = options.title;
    this.#description = options.description;
    this.#fields = options.fields;
    this.#submitLabel = options.submitLabel ?? "Submit";
    this.#onSubmit = options.onSubmit;
    this.#onClose = options.onClose;
    this.#inputs = options.fields.map((field) => {
      const input = new Input();
      input.focused = false;
      if (field.initialValue) setInputValueAtEnd(input, field.initialValue);
      return input;
    });
    this.#syncFocus();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.#onClose();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      this.#index = Math.min(this.#fields.length - 1, this.#index + 1);
      this.#syncFocus();
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, Key.up)) {
      this.#index = Math.max(0, this.#index - 1);
      this.#syncFocus();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.#index < this.#fields.length - 1) {
        this.#index += 1;
        this.#syncFocus();
        return;
      }
      this.#submit();
      return;
    }
    this.#inputs[this.#index]?.handleInput(data);
    this.#error = undefined;
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const lines = [
      ...panelHeader(
        this.title,
        "Tab/↑↓ fields · type to edit · Enter next/submit · Esc cancel",
        safe,
      ),
      "",
    ];
    if (this.#description) {
      lines.push(truncateToWidth(theme.fg("textDim", `  ${this.#description}`), safe, "…"), "");
    }
    for (const [index, field] of this.#fields.entries()) {
      const selected = index === this.#index;
      const input = this.#inputs[index]!;
      const raw = input.getValue();
      const marker = selected ? theme.fg("primary", "❯ ") : "  ";
      lines.push(truncateToWidth(`${marker}${theme.bold(field.label)}`, safe, "…"));
      if (selected && !field.secret) {
        // Use Input.render so the caret is visible while editing (incl. prefilled model).
        const [rendered = "> "] = input.render(Math.max(12, safe - 4));
        const body = rendered.replace(/^\s*>\s?/, "");
        lines.push(truncateToWidth(`    ${theme.fg("primary", "> ")}${body}`, safe, "…"));
      } else {
        const shown = field.secret && raw ? "•".repeat(Math.min(raw.length, 24)) : raw;
        const value = shown || theme.fg("textMuted", field.placeholder ?? "");
        const caret = selected ? theme.fg("primary", "▌") : "";
        lines.push(truncateToWidth(
          `    ${selected ? theme.fg("primary", "> ") : "  "}${value}${caret}`,
          safe,
          "…",
        ));
      }
      lines.push("");
    }
    if (this.#error) {
      lines.push(truncateToWidth(theme.fg("error", `  ${this.#error}`), safe, "…"), "");
    }
    lines.push(theme.fg("textDim", `  ${this.#submitLabel} when the last field is focused.`));
    lines.push("", ...panelFooter(safe));
    return lines;
  }

  #syncFocus(): void {
    for (const [index, input] of this.#inputs.entries()) {
      input.focused = index === this.#index;
    }
  }

  #submit(): void {
    const values: Record<string, string> = {};
    for (const [index, field] of this.#fields.entries()) {
      const value = (this.#inputs[index]?.getValue() ?? "").trim();
      if (field.required !== false && !value) {
        this.#error = `${field.label} is required.`;
        this.#index = index;
        this.#syncFocus();
        return;
      }
      values[field.id] = value;
    }
    this.#onSubmit(values);
  }
}

/**
 * `Input.setValue` keeps the previous cursor (0 for a fresh Input), so Backspace appears
 * broken on prefilled fields. Advance the cursor before setValue so it lands at the end.
 */
function setInputValueAtEnd(input: Input, value: string): void {
  const state = input as unknown as { cursor: number };
  state.cursor = Number.MAX_SAFE_INTEGER;
  input.setValue(value);
}
