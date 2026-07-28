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
  /**
   * Render this field as a terminal dropdown. Up/down or left/right changes
   * the selected option while Tab continues to move between fields.
   */
  readonly options?: readonly FormFieldOption[];
}

export interface FormFieldOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** The option's value is entered through an inline text box. Keep this last. */
  readonly customInput?: boolean;
  readonly placeholder?: string;
}

export interface FormPanelOptions {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly FormField[];
  readonly submitLabel?: string;
  readonly onSubmit: (values: Readonly<Record<string, string>>) => void;
  /**
   * Return dependent-field patches after a value changes. Patches only replace
   * fields the operator has not edited, so a manual override remains stable.
   */
  readonly onChange?: (
    fieldId: string,
    value: string,
    values: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>> | void;
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
  readonly #onChange: FormPanelOptions["onChange"];
  readonly #onClose: () => void;
  readonly #inputs: Input[];
  readonly #selectedOptions: number[];
  readonly #dirty: boolean[];
  #index = 0;
  #error: string | undefined;

  constructor(options: FormPanelOptions) {
    this.title = options.title;
    this.#description = options.description;
    this.#fields = options.fields;
    this.#submitLabel = options.submitLabel ?? "Submit";
    this.#onSubmit = options.onSubmit;
    this.#onChange = options.onChange;
    this.#onClose = options.onClose;
    this.#selectedOptions = [];
    this.#dirty = options.fields.map(() => false);
    this.#inputs = options.fields.map((field, index) => {
      const input = new Input();
      input.focused = false;
      const selected = initialOptionIndex(field);
      this.#selectedOptions[index] = selected;
      const selectedOption = field.options?.[selected];
      if (field.initialValue && (!field.options || selectedOption?.customInput)) {
        setInputValueAtEnd(input, field.initialValue);
      }
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
    const field = this.#fields[this.#index];
    if (matchesKey(data, Key.tab)) {
      this.#index = Math.min(this.#fields.length - 1, this.#index + 1);
      this.#syncFocus();
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.#index = Math.max(0, this.#index - 1);
      this.#syncFocus();
      return;
    }
    if (
      field?.options &&
      (
        matchesKey(data, Key.down) ||
        matchesKey(data, Key.right) ||
        matchesKey(data, Key.up) ||
        matchesKey(data, Key.left)
      )
    ) {
      const direction = matchesKey(data, Key.down) || matchesKey(data, Key.right) ? 1 : -1;
      this.#selectOption(this.#index, direction);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#index = Math.min(this.#fields.length - 1, this.#index + 1);
      this.#syncFocus();
      return;
    }
    if (matchesKey(data, Key.up)) {
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
    if (field?.options && !this.#selectedOption(this.#index)?.customInput) return;
    this.#inputs[this.#index]?.handleInput(data);
    this.#dirty[this.#index] = true;
    this.#notifyChange(this.#index);
    this.#error = undefined;
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const lines = [
      ...panelHeader(
        this.title,
        "Tab fields · ↑↓ choices · type to edit · Enter next/submit · Esc cancel",
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
      if (field.options) {
        const selectedOption = this.#selectedOption(index);
        if (selected) {
          for (const option of field.options) {
            const current = option === selectedOption;
            const optionMarker = current ? theme.fg("primary", "●") : theme.fg("textMuted", "○");
            const label = current ? theme.bold(option.label) : option.label;
            const description = option.description
              ? theme.fg("textDim", ` · ${option.description}`)
              : "";
            lines.push(truncateToWidth(`    ${optionMarker} ${label}${description}`, safe, "…"));
          }
        } else {
          lines.push(truncateToWidth(
            `    ${selectedOption?.label ?? theme.fg("textMuted", field.placeholder ?? "")}`,
            safe,
            "…",
          ));
        }
        if (selectedOption?.customInput) {
          if (selected) {
            const [rendered = "> "] = input.render(Math.max(12, safe - 4));
            const body = rendered.replace(/^\s*>\s?/, "");
            const fallback = body || theme.fg("textMuted", selectedOption.placeholder ?? field.placeholder ?? "");
            lines.push(truncateToWidth(`    ${theme.fg("primary", "> ")}${fallback}`, safe, "…"));
          } else {
            const value = raw || theme.fg(
              "textMuted",
              selectedOption.placeholder ?? field.placeholder ?? "",
            );
            lines.push(truncateToWidth(`      ${value}`, safe, "…"));
          }
        }
      } else if (selected && !field.secret) {
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
      input.focused = index === this.#index &&
        (!this.#fields[index]?.options || this.#selectedOption(index)?.customInput === true);
    }
  }

  #submit(): void {
    const values = this.#values();
    for (const [index, field] of this.#fields.entries()) {
      const value = values[field.id] ?? "";
      if (field.required !== false && !value) {
        this.#error = `${field.label} is required.`;
        this.#index = index;
        this.#syncFocus();
        return;
      }
    }
    this.#onSubmit(values);
  }

  #selectedOption(index: number): FormFieldOption | undefined {
    return this.#fields[index]?.options?.[this.#selectedOptions[index] ?? 0];
  }

  #selectOption(index: number, direction: number): void {
    const options = this.#fields[index]?.options;
    if (!options || options.length === 0) return;
    const current = this.#selectedOptions[index] ?? 0;
    this.#selectedOptions[index] = (current + direction + options.length) % options.length;
    this.#dirty[index] = true;
    this.#syncFocus();
    this.#notifyChange(index);
    this.#error = undefined;
  }

  #notifyChange(index: number): void {
    if (!this.#onChange) return;
    const field = this.#fields[index];
    if (!field) return;
    const values = this.#values();
    const patches = this.#onChange(field.id, values[field.id] ?? "", values);
    if (!patches) return;
    for (const [id, value] of Object.entries(patches)) {
      const target = this.#fields.findIndex((candidate) => candidate.id === id);
      if (target < 0 || this.#dirty[target]) continue;
      this.#setValue(target, value);
    }
  }

  #setValue(index: number, value: string): void {
    const field = this.#fields[index];
    if (!field) return;
    if (!field.options) {
      setInputValueAtEnd(this.#inputs[index]!, value);
      return;
    }
    const matched = field.options.findIndex((option) => !option.customInput && option.value === value);
    if (matched >= 0) {
      this.#selectedOptions[index] = matched;
      return;
    }
    const custom = field.options.findIndex((option) => option.customInput);
    if (custom >= 0) {
      this.#selectedOptions[index] = custom;
      setInputValueAtEnd(this.#inputs[index]!, value);
    }
  }

  #values(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [index, field] of this.#fields.entries()) {
      const option = this.#selectedOption(index);
      values[field.id] = (
        field.options
          ? option?.customInput
            ? this.#inputs[index]?.getValue() ?? ""
            : option?.value ?? ""
          : this.#inputs[index]?.getValue() ?? ""
      ).trim();
    }
    return values;
  }
}

function initialOptionIndex(field: FormField): number {
  if (!field.options || field.options.length === 0) return 0;
  const initial = field.initialValue?.trim();
  if (initial) {
    const exact = field.options.findIndex((option) => !option.customInput && option.value === initial);
    if (exact >= 0) return exact;
    const custom = field.options.findIndex((option) => option.customInput);
    if (custom >= 0) return custom;
  }
  return 0;
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
