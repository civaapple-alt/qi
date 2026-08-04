import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { currentMark, panelFooter, panelHeader, pointer } from "./chrome.js";
import type { PanelComponent, PanelItem } from "./types.js";

export interface ListPanelOptions {
  readonly title: string;
  readonly items: readonly PanelItem[];
  readonly hints?: string;
  readonly searchable?: boolean;
  readonly maxVisible?: number;
  /** 0-based index into `items` before filtering. */
  readonly initialSelected?: number;
  readonly onSelect: (item: PanelItem) => void;
  readonly onClose: () => void;
}

/** Searchable selectable list: /mode, /runs, settings categories, etc. */
export class ListPanel implements PanelComponent, Focusable {
  readonly title: string;
  focused = false;
  readonly #all: readonly PanelItem[];
  readonly #hints: string;
  readonly #searchable: boolean;
  readonly #maxVisible: number;
  readonly #onSelect: (item: PanelItem) => void;
  readonly #onClose: () => void;
  readonly #search: Input;
  #filtered: PanelItem[];
  #selected = 0;
  #query = "";

  constructor(options: ListPanelOptions) {
    this.title = options.title;
    this.#all = options.items;
    this.#filtered = [...options.items];
    this.#hints = options.hints ?? "↑↓ navigate · Enter select · Esc cancel";
    this.#searchable = options.searchable ?? false;
    this.#maxVisible = Math.max(5, options.maxVisible ?? 12);
    this.#onSelect = options.onSelect;
    this.#onClose = options.onClose;
    this.#search = new Input();
    this.#search.focused = false;
    if (options.initialSelected !== undefined) {
      this.#selected = Math.max(0, Math.min(options.initialSelected, Math.max(0, this.#all.length - 1)));
    }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.#query) {
        this.#query = "";
        this.#search.setValue("");
        this.#applyFilter();
        return;
      }
      this.#onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#selected = Math.max(0, this.#selected - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#selected = Math.min(Math.max(0, this.#filtered.length - 1), this.#selected + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const item = this.#filtered[this.#selected];
      if (item && !item.disabled) this.#onSelect(item);
      return;
    }
    if (!this.#searchable) return;
    this.#search.handleInput(data);
    this.#query = this.#search.getValue();
    this.#applyFilter();
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const headerHints = this.#searchable
      ? `${this.#hints} · type to search`
      : this.#hints;
    const lines = [...panelHeader(this.title, headerHints, safe), ""];
    if (this.#searchable && this.#query) {
      lines.push(truncateToWidth(theme.fg("textDim", ` filter: ${this.#query}`), safe, "…"), "");
    }
    if (this.#filtered.length === 0) {
      lines.push(theme.fg("textMuted", "  No matches."), "", ...panelFooter(safe));
      return lines;
    }
    const start = Math.max(
      0,
      Math.min(this.#selected - Math.floor(this.#maxVisible / 2), this.#filtered.length - this.#maxVisible),
    );
    const end = Math.min(start + this.#maxVisible, this.#filtered.length);
    for (let index = start; index < end; index += 1) {
      const item = this.#filtered[index]!;
      const selected = index === this.#selected;
      // Panel items can contain remote metadata (for example MCP tool
      // descriptions). Keep every rendered item field to one terminal row;
      // embedded newlines would desynchronize differential rendering.
      const labelText = item.label.replace(/\s+/g, " ").trim();
      const label = selected ? theme.bold(labelText) : labelText;
      const dimmed = item.disabled ? theme.fg("textDim", label) : label;
      const description = item.description?.replace(/\s+/g, " ").trim();
      const desc = description
        ? theme.fg("textDim", `  ${description}`)
        : "";
      lines.push(truncateToWidth(`${pointer(selected)}${dimmed}${currentMark(Boolean(item.current))}`, safe, "…"));
      if (desc) lines.push(truncateToWidth(`    ${desc}`, safe, "…"));
    }
    const info = this.#filtered.length > this.#maxVisible
      ? `${this.#selected + 1}/${this.#filtered.length}`
      : undefined;
    lines.push("", ...panelFooter(safe, info));
    return lines;
  }

  #applyFilter(): void {
    const needle = this.#query.trim().toLowerCase();
    this.#filtered = needle
      ? this.#all.filter((item) =>
        item.label.toLowerCase().includes(needle) ||
        (item.description?.toLowerCase().includes(needle) ?? false))
      : [...this.#all];
    this.#selected = Math.min(this.#selected, Math.max(0, this.#filtered.length - 1));
  }
}
