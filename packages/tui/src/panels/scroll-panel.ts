import { Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { panelFooter, panelHeader } from "./chrome.js";
import type { PanelComponent } from "./types.js";

export interface ScrollPanelOptions {
  readonly title: string;
  readonly lines: readonly string[];
  readonly hints?: string;
  readonly maxVisible?: number;
  readonly onClose: () => void;
}

/** Read-only scrollable panel: /config, /help, /status, etc. */
export class ScrollPanel implements PanelComponent, Focusable {
  readonly title: string;
  focused = false;
  readonly #lines: readonly string[];
  readonly #hints: string;
  readonly #maxVisible: number;
  readonly #onClose: () => void;
  #scrollTop = 0;

  constructor(options: ScrollPanelOptions) {
    this.title = options.title;
    this.#lines = options.lines;
    this.#hints = options.hints ?? "Esc / Enter / q close · ↑↓ scroll";
    this.#maxVisible = Math.max(5, options.maxVisible ?? 24);
    this.#onClose = options.onClose;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      data === "q" ||
      data === "Q"
    ) {
      this.#onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#scrollTop = Math.max(0, this.#scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.#scrollTop = Math.max(0, this.#scrollTop - this.#maxVisible);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.#scrollTop += this.#maxVisible;
    }
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const header = panelHeader(this.title, this.#hints, safe);
    const bodyBudget = Math.max(3, this.#maxVisible);
    const maxScroll = Math.max(0, this.#lines.length - bodyBudget);
    this.#scrollTop = Math.min(this.#scrollTop, maxScroll);
    const slice = this.#lines.slice(this.#scrollTop, this.#scrollTop + bodyBudget);
    const info = this.#lines.length > bodyBudget
      ? `showing ${this.#scrollTop + 1}-${this.#scrollTop + slice.length} of ${this.#lines.length}`
      : undefined;
    const body = slice.map((line) => {
      if (!line) return "";
      if (/^[A-Za-z].{0,40}$/.test(line) && !line.startsWith("  ")) {
        return truncateToWidth(theme.bold(line), safe, "…");
      }
      return truncateToWidth(line, safe, "…");
    });
    return [...header, "", ...body, "", ...panelFooter(safe, info)];
  }
}
