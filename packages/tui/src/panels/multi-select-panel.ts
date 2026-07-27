import { Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { currentMark, panelFooter, panelHeader, pointer } from "./chrome.js";
import type { PanelComponent, PanelItem } from "./types.js";

export interface MultiSelectPanelOptions {
  readonly title: string;
  readonly items: readonly PanelItem[];
  /** Item ids that start checked. */
  readonly selectedIds?: readonly string[];
  /** Item ids marked as currently effective (← current), independent of draft selection. */
  readonly currentIds?: readonly string[];
  readonly hints?: string;
  readonly maxVisible?: number;
  readonly onApply: (selectedIds: readonly string[]) => void;
  readonly onClose: () => void;
}

/** Space-togglable multi-select list: /permissions capabilities, etc. */
export class MultiSelectPanel implements PanelComponent, Focusable {
  readonly title: string;
  focused = false;
  readonly #items: readonly PanelItem[];
  readonly #currentIds: ReadonlySet<string>;
  readonly #hints: string;
  readonly #maxVisible: number;
  readonly #onApply: (selectedIds: readonly string[]) => void;
  readonly #onClose: () => void;
  readonly #selected = new Set<string>();
  #cursor = 0;

  constructor(options: MultiSelectPanelOptions) {
    this.title = options.title;
    this.#items = options.items;
    this.#currentIds = new Set(options.currentIds ?? []);
    this.#hints = options.hints ?? "↑↓ navigate · Space toggle · Enter apply · Esc cancel";
    this.#maxVisible = Math.max(5, options.maxVisible ?? 12);
    this.#onApply = options.onApply;
    this.#onClose = options.onClose;
    for (const id of options.selectedIds ?? []) this.#selected.add(id);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.#onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#cursor = Math.max(0, this.#cursor - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#cursor = Math.min(Math.max(0, this.#items.length - 1), this.#cursor + 1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      const item = this.#items[this.#cursor];
      if (!item || item.disabled) return;
      if (this.#selected.has(item.id)) this.#selected.delete(item.id);
      else this.#selected.add(item.id);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.#onApply([...this.#selected]);
    }
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const lines = [...panelHeader(this.title, this.#hints, safe), ""];
    if (this.#items.length === 0) {
      lines.push(theme.fg("textMuted", "  No options."), "", ...panelFooter(safe));
      return lines;
    }
    const start = Math.max(
      0,
      Math.min(this.#cursor - Math.floor(this.#maxVisible / 2), this.#items.length - this.#maxVisible),
    );
    const end = Math.min(start + this.#maxVisible, this.#items.length);
    for (let index = start; index < end; index += 1) {
      const item = this.#items[index]!;
      const focused = index === this.#cursor;
      const checked = this.#selected.has(item.id);
      const box = checked ? "[x]" : "[ ]";
      const label = focused ? theme.bold(`${box} ${item.label}`) : `${box} ${item.label}`;
      const dimmed = item.disabled ? theme.fg("textDim", label) : label;
      lines.push(truncateToWidth(
        `${pointer(focused)}${dimmed}${currentMark(this.#currentIds.has(item.id))}`,
        safe,
        "…",
      ));
      if (item.description) {
        lines.push(truncateToWidth(theme.fg("textDim", `    ${item.description}`), safe, "…"));
      }
    }
    const info = `${this.#selected.size} selected · ${this.#cursor + 1}/${this.#items.length}`;
    lines.push("", ...panelFooter(safe, info));
    return lines;
  }
}
