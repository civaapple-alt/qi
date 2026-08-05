import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { panelFooter, panelHeader, pointer, theme, type PanelComponent } from "@civaapple/qi-tui";

export type SkillBrowserTab = "native" | "global" | "plugin" | "install";

export interface SkillBrowserItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface SkillBrowserPanelOptions {
  readonly native: readonly SkillBrowserItem[];
  readonly global: readonly SkillBrowserItem[];
  readonly plugin: readonly SkillBrowserItem[];
  readonly maxVisible?: number;
  readonly onSelect: (tab: Exclude<SkillBrowserTab, "install">, item: SkillBrowserItem) => void;
  readonly onInstall: () => void;
  readonly onClose: () => void;
}

/** Compact horizontal Skills hub; detailed choice flows remain behind Enter. */
export class SkillBrowserPanel implements PanelComponent, Focusable {
  readonly title = "Skills";
  focused = false;
  readonly #items: Readonly<Record<Exclude<SkillBrowserTab, "install">, readonly SkillBrowserItem[]>>;
  readonly #maxVisible: number;
  readonly #onSelect: SkillBrowserPanelOptions["onSelect"];
  readonly #onInstall: () => void;
  readonly #onClose: () => void;
  readonly #search = new Input();
  #tabIndex = 0;
  #selected = 0;
  #query = "";
  #filtered: SkillBrowserItem[] = [];

  constructor(options: SkillBrowserPanelOptions) {
    this.#items = { native: options.native, global: options.global, plugin: options.plugin };
    this.#maxVisible = Math.max(5, options.maxVisible ?? 12);
    this.#onSelect = options.onSelect;
    this.#onInstall = options.onInstall;
    this.#onClose = options.onClose;
    this.#search.focused = false;
    this.#applyFilter();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.#query) {
        this.#query = ""; this.#search.setValue(""); this.#applyFilter();
      } else this.#onClose();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) {
      this.#tabIndex = (this.#tabIndex + TABS.length - 1) % TABS.length;
      this.#selected = 0; this.#applyFilter(); return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.#tabIndex = (this.#tabIndex + 1) % TABS.length;
      this.#selected = 0; this.#applyFilter(); return;
    }
    if (matchesKey(data, Key.up)) { this.#selected = Math.max(0, this.#selected - 1); return; }
    if (matchesKey(data, Key.down)) { this.#selected = Math.min(Math.max(0, this.#filtered.length - 1), this.#selected + 1); return; }
    if (matchesKey(data, Key.enter)) {
      if (this.#tab === "install") this.#onInstall();
      else {
        const item = this.#filtered[this.#selected];
        if (item) this.#onSelect(this.#tab, item);
      }
      return;
    }
    this.#search.handleInput(data); this.#query = this.#search.getValue(); this.#applyFilter();
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const lines = [
      ...panelHeader(this.title, "←/→ tab · Enter manage · type to search · Esc close", safe),
      theme.fg("textDim", "Browse native, global Agent, and marketplace Skills."),
      "",
      truncateToWidth(TABS.map((tab, index) => this.#renderTab(tab, index === this.#tabIndex)).join("  "), safe, "…"),
      "",
    ];
    if (this.#tab === "install") {
      lines.push(theme.bold("Install Skill"), theme.fg("textDim", "Enter chooses GitHub or a local source; installation location comes last."), "", ...panelFooter(safe));
      return lines;
    }
    lines.push(...this.#renderSearch(safe), "");
    if (this.#filtered.length === 0) {
      lines.push(theme.fg("textMuted", "  No matching Skills."), "", ...panelFooter(safe));
      return lines;
    }
    const start = Math.max(0, Math.min(this.#selected - Math.floor(this.#maxVisible / 2), this.#filtered.length - this.#maxVisible));
    const end = Math.min(start + this.#maxVisible, this.#filtered.length);
    for (let index = start; index < end; index += 1) {
      const item = this.#filtered[index]!;
      const label = index === this.#selected ? theme.bold(item.label) : item.label;
      lines.push(truncateToWidth(`${pointer(index === this.#selected)}${label}  ${theme.fg("textDim", item.description.replace(/\s+/g, " ").trim())}`, safe, "…"));
    }
    lines.push("", ...panelFooter(safe, this.#filtered.length > this.#maxVisible ? `${this.#selected + 1}/${this.#filtered.length}` : undefined));
    return lines;
  }

  get #tab(): SkillBrowserTab { return TABS[this.#tabIndex]!; }

  #renderTab(tab: SkillBrowserTab, selected: boolean): string {
    const count = tab === "install" ? undefined : this.#items[tab].length;
    const label = `${TAB_LABEL[tab]}${count === undefined ? "" : ` (${count})`}`;
    return selected ? theme.bold(`[${label}]`) : theme.fg("textDim", label);
  }

  #renderSearch(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const text = this.#query ? `⌕ ${this.#query}` : theme.fg("textDim", "⌕ Search skills");
    return [`┌${"─".repeat(Math.max(1, width - 2))}┐`, `│ ${truncateToWidth(text, inner, "…").padEnd(inner)} │`, `└${"─".repeat(Math.max(1, width - 2))}┘`];
  }

  #applyFilter(): void {
    if (this.#tab === "install") { this.#filtered = []; return; }
    const needle = this.#query.trim().toLowerCase();
    const items = this.#items[this.#tab];
    this.#filtered = (needle ? items.filter((item) => `${item.label}\n${item.description}`.toLowerCase().includes(needle)) : items).slice();
    this.#selected = Math.min(this.#selected, Math.max(0, this.#filtered.length - 1));
  }
}

const TABS = ["native", "global", "plugin", "install"] as const;
const TAB_LABEL: Readonly<Record<SkillBrowserTab, string>> = {
  native: "Native",
  global: "Global Agent",
  plugin: "Plugin Skills",
  install: "Install",
};
