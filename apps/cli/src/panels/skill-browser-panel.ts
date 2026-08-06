import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { panelFooter, panelHeader, pointer, theme, type PanelComponent } from "@civaapple/qi-tui";

export type SkillBrowserTab = "native" | "global" | `plugin:${string}` | "install";

export interface SkillBrowserItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface SkillBrowserPluginMarket {
  readonly marketplace: string;
  readonly items: readonly SkillBrowserItem[];
}

export interface SkillBrowserPanelOptions {
  readonly native: readonly SkillBrowserItem[];
  readonly global: readonly SkillBrowserItem[];
  readonly pluginMarkets: readonly SkillBrowserPluginMarket[];
  readonly maxVisible?: number;
  readonly onSelect: (tab: Exclude<SkillBrowserTab, "install">, item: SkillBrowserItem) => void;
  readonly onToggle?: (tab: Exclude<SkillBrowserTab, "install">, item: SkillBrowserItem) => void | Promise<void>;
  readonly onInstall: () => void;
  readonly onClose: () => void;
}

/** Compact horizontal Skills hub; detailed choice flows remain behind Enter. */
export class SkillBrowserPanel implements PanelComponent, Focusable {
  readonly title = "Skills";
  focused = false;
  #items: Record<string, readonly SkillBrowserItem[]>;
  readonly #tabs: readonly SkillBrowserTab[];
  readonly #maxVisible: number;
  readonly #onSelect: SkillBrowserPanelOptions["onSelect"];
  readonly #onToggle: SkillBrowserPanelOptions["onToggle"];
  readonly #onInstall: () => void;
  readonly #onClose: () => void;
  readonly #search = new Input();
  #tabIndex = 0;
  #selected = 0;
  #query = "";
  #filtered: SkillBrowserItem[] = [];

  constructor(options: SkillBrowserPanelOptions) {
    const markets = options.pluginMarkets
      .map((entry) => entry.marketplace.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    this.#tabs = ["native", "global", ...markets.map((marketplace) => `plugin:${marketplace}` as const), "install"];
    this.#items = {
      native: options.native,
      global: options.global,
      ...Object.fromEntries(options.pluginMarkets.map((entry) => [`plugin:${entry.marketplace}`, entry.items])),
    };
    this.#maxVisible = Math.max(5, options.maxVisible ?? 12);
    this.#onSelect = options.onSelect;
    this.#onToggle = options.onToggle;
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
      this.#tabIndex = (this.#tabIndex + this.#tabs.length - 1) % this.#tabs.length;
      this.#selected = 0; this.#applyFilter(); return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.#tabIndex = (this.#tabIndex + 1) % this.#tabs.length;
      this.#selected = 0; this.#applyFilter(); return;
    }
    if (matchesKey(data, Key.up)) { this.#selected = Math.max(0, this.#selected - 1); return; }
    if (matchesKey(data, Key.down)) { this.#selected = Math.min(Math.max(0, this.#filtered.length - 1), this.#selected + 1); return; }
    if (matchesKey(data, Key.enter)) {
      if (this.#tab === "install") this.#onInstall();
      else {
        const item = this.#filtered[this.#selected];
        if (item) this.#onSelect(this.#tab as Exclude<SkillBrowserTab, "install">, item);
      }
      return;
    }
    if (data === " " && this.#tab.startsWith("plugin:")) {
      const item = this.#filtered[this.#selected];
      if (item) void this.#onToggle?.(this.#tab as Exclude<SkillBrowserTab, "install">, item);
      return;
    }
    this.#search.handleInput(data); this.#query = this.#search.getValue(); this.#applyFilter();
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const lines = [
      ...panelHeader(this.title, "←/→ tab · Space enable/disable · Enter details/manage · type to search · Esc close", safe),
      theme.fg("textDim", "Browse native, global Agent, and marketplace Skills."),
      "",
      truncateToWidth(this.#tabs.map((tab, index) => this.#renderTab(tab, index === this.#tabIndex)).join("  "), safe, "…"),
      "",
    ];
    if (this.#tab === "install") {
      lines.push(
        theme.bold("Install / Remove"),
        theme.fg("textDim", "Enter installs a new Skill or removes a user/Workspace Qi copy."),
        "",
        ...panelFooter(safe),
      );
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

  get #tab(): SkillBrowserTab { return this.#tabs[this.#tabIndex]!; }

  updateItem(item: SkillBrowserItem): void {
    for (const [tab, items] of Object.entries(this.#items)) {
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) continue;
      this.#items[tab] = [...items.slice(0, index), item, ...items.slice(index + 1)];
      this.#applyFilter();
      return;
    }
  }

  #renderTab(tab: SkillBrowserTab, selected: boolean): string {
    const items = tab === "install" ? undefined : this.#items[tab];
    const count = items?.length;
    const tabLabel = tab === "install"
      ? "Install"
      : tab.startsWith("plugin:")
        ? tab.slice("plugin:".length)
        : TAB_LABEL[tab as "native" | "global"];
    const enabled = tab.startsWith("plugin:") ? items?.filter((item) => item.label.startsWith("[*]")).length ?? 0 : undefined;
    const countLabel = count === undefined ? "" : enabled === undefined ? ` (${count})` : ` (${enabled}/${count})`;
    const label = `${tabLabel}${countLabel}`;
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
    const items = this.#items[this.#tab] ?? [];
    this.#filtered = (needle ? items.filter((item) => `${item.label}\n${item.description}`.toLowerCase().includes(needle)) : items).slice();
    this.#selected = Math.min(this.#selected, Math.max(0, this.#filtered.length - 1));
  }
}

const TAB_LABEL: Readonly<Record<"native" | "global", string>> = {
  native: "Native",
  global: "Global Agent",
};
