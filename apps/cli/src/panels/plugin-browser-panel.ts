import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { panelFooter, panelHeader, pointer, theme, type PanelComponent } from "@civaapple/qi-tui";

export type PluginBrowserTab = "all" | "installed" | "manage" | `marketplace:${string}`;

export interface PluginBrowserItem {
  readonly id: string;
  /** Stable marketplace identifier; `name` may be a display label. */
  readonly pluginName: string;
  readonly name: string;
  readonly marketplace: string;
  readonly description: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly version?: string;
  readonly sourceKind?: string;
}

export interface PluginBrowserPanelOptions {
  readonly items: readonly PluginBrowserItem[];
  readonly marketplaces: readonly string[];
  readonly initialTab?: PluginBrowserTab;
  readonly initialQuery?: string;
  readonly maxVisible?: number;
  readonly onOpen: (item: PluginBrowserItem) => void;
  readonly onToggle: (item: PluginBrowserItem) => void;
  /** Open marketplace management (add / sync / enable / browse). */
  readonly onManageMarketplaces: () => void;
  readonly onClose: () => void;
}

/**
 * Marketplace-first plugin browser. It deliberately owns only local selection
 * state: installation, enablement and registry writes remain application actions.
 */
export class PluginBrowserPanel implements PanelComponent, Focusable {
  readonly title = "Plugins";
  focused = false;
  readonly #all: readonly PluginBrowserItem[];
  readonly #tabs: readonly PluginBrowserTab[];
  readonly #maxVisible: number;
  readonly #onOpen: (item: PluginBrowserItem) => void;
  readonly #onToggle: (item: PluginBrowserItem) => void;
  readonly #onManageMarketplaces: () => void;
  readonly #onClose: () => void;
  readonly #search = new Input();
  #tabIndex = 0;
  #selected = 0;
  #query = "";
  #filtered: PluginBrowserItem[] = [];

  constructor(options: PluginBrowserPanelOptions) {
    this.#all = options.items;
    this.#tabs = ["all", "installed", ...options.marketplaces.map((name) => `marketplace:${name}` as const), "manage"];
    this.#maxVisible = Math.max(5, options.maxVisible ?? 12);
    this.#onOpen = options.onOpen;
    this.#onToggle = options.onToggle;
    this.#onManageMarketplaces = options.onManageMarketplaces;
    this.#onClose = options.onClose;
    this.#search.focused = false;
    const initialTab = options.initialTab;
    if (initialTab !== undefined) {
      const index = this.#tabs.indexOf(initialTab);
      if (index >= 0) this.#tabIndex = index;
    }
    this.#query = options.initialQuery?.trim() ?? "";
    this.#search.setValue(this.#query);
    this.#applyFilter();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.#query) {
        this.#query = "";
        this.#search.setValue("");
        this.#applyFilter();
      } else {
        this.#onClose();
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) {
      this.#tabIndex = (this.#tabIndex + this.#tabs.length - 1) % this.#tabs.length;
      this.#selected = 0;
      this.#applyFilter();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.#tabIndex = (this.#tabIndex + 1) % this.#tabs.length;
      this.#selected = 0;
      this.#applyFilter();
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
      if (this.#tab === "manage") this.#onManageMarketplaces();
      else {
        const item = this.#filtered[this.#selected];
        if (item) this.#onOpen(item);
      }
      return;
    }
    if (data === " " && this.#tab !== "manage") {
      const item = this.#filtered[this.#selected];
      if (item) this.#onToggle(item);
      return;
    }
    this.#search.handleInput(data);
    this.#query = this.#search.getValue();
    this.#applyFilter();
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const installed = this.#all.filter((item) => item.installed).length;
    const lines = [
      ...panelHeader(this.title, "←/→ tab · Space enable/disable · Enter details · Esc close", safe),
      theme.fg("textDim", `Browse plugins from available marketplaces. Installed ${installed} of ${this.#all.length} available plugins.`),
      "",
      truncateToWidth(this.#tabs.map((tab, index) => this.#renderTab(tab, index === this.#tabIndex)).join("  "), safe, "…"),
      "",
    ];
    if (this.#tab === "manage") {
      lines.push(
        theme.bold("Manage marketplaces"),
        theme.fg("textDim", "Enter: add source · sync catalog · enable/disable · browse plugins."),
        "",
        ...panelFooter(safe),
      );
      return lines;
    }
    lines.push(...this.#renderSearch(safe), "");
    if (this.#filtered.length === 0) {
      lines.push(theme.fg("textMuted", "  No matching plugins."), "", ...panelFooter(safe));
      return lines;
    }
    const start = Math.max(0, Math.min(this.#selected - Math.floor(this.#maxVisible / 2), this.#filtered.length - this.#maxVisible));
    const end = Math.min(start + this.#maxVisible, this.#filtered.length);
    for (let index = start; index < end; index += 1) {
      const item = this.#filtered[index]!;
      lines.push(...this.#renderItem(item, index === this.#selected, safe));
    }
    lines.push("", ...panelFooter(safe, this.#filtered.length > this.#maxVisible ? `${this.#selected + 1}/${this.#filtered.length}` : undefined));
    return lines;
  }

  get #tab(): PluginBrowserTab {
    return this.#tabs[this.#tabIndex]!;
  }

  #renderTab(tab: PluginBrowserTab, selected: boolean): string {
    const label = tab === "all"
      ? `All (${this.#all.length})`
      : tab === "installed"
        ? `Installed (${this.#all.filter((item) => item.installed).length})`
        : tab === "manage"
          ? "Manage"
          : tab.slice("marketplace:".length);
    return selected ? theme.bold(`[${label}]`) : theme.fg("textDim", label);
  }

  #renderSearch(width: number): string[] {
    const text = this.#query ? `⌕ ${this.#query}` : theme.fg("textDim", "⌕ Search plugins");
    const inner = Math.max(1, width - 4);
    return [
      `┌${"─".repeat(Math.max(1, width - 2))}┐`,
      `│ ${truncateToWidth(text, inner, "…").padEnd(inner)} │`,
      `└${"─".repeat(Math.max(1, width - 2))}┘`,
    ];
  }

  #renderItem(item: PluginBrowserItem, selected: boolean, width: number): string[] {
    const mark = item.enabled ? "[*]" : item.installed ? "[-]" : "[ ]";
    const state = item.enabled ? "Enabled" : item.installed ? "Installed" : "Available";
    const title = selected ? theme.bold(item.name) : item.name;
    const version = item.version ? ` · v${item.version}` : "";
    const meta = `${state} · ${item.marketplace}${version}`;
    const description = item.description.replace(/\s+/g, " ").trim();
    return [
      truncateToWidth(
        `${pointer(selected)}${mark} ${title}  ${theme.fg("textDim", `${meta} · ${description}`)}`,
        width,
        "…",
      ),
    ];
  }

  #applyFilter(): void {
    const tab = this.#tab;
    const tabItems = tab === "all"
      ? this.#all
      : tab === "installed"
        ? this.#all.filter((item) => item.installed)
        : tab === "manage"
          ? []
          : this.#all.filter((item) => item.marketplace === tab.slice("marketplace:".length));
    const needle = this.#query.trim().toLowerCase();
    this.#filtered = (needle
      ? tabItems.filter((item) => `${item.name}\n${item.marketplace}\n${item.description}`.toLowerCase().includes(needle))
      : tabItems)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name) || left.marketplace.localeCompare(right.marketplace));
    this.#selected = Math.min(this.#selected, Math.max(0, this.#filtered.length - 1));
  }
}
