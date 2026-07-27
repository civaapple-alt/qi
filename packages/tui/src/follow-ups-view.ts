import type { Component } from "@earendil-works/pi-tui";
import { FollowUpQueue } from "./follow-ups.js";
import { t, type Locale } from "./i18n.js";
import { truncateToWidth, visibleWidth } from "./layout.js";
import { theme } from "./theme/index.js";

/** Cursor-style follow-ups box above the composer. */
export class FollowUpsComponent implements Component {
  readonly #queue: FollowUpQueue;
  readonly #locale: () => Locale;

  constructor(queue: FollowUpQueue, locale: () => Locale) {
    this.#queue = queue;
    this.#locale = locale;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.#queue.length === 0) return [];
    const usable = Math.max(24, width);
    const locale = this.#locale();
    const title = t(locale, "followups.title");
    const hint = this.#queue.editing
      ? t(locale, "followups.hint.editing")
      : t(locale, "followups.hint.browse");
    const rule = theme.fg("border", "─".repeat(usable));
    const headerLeft = theme.fg("textMuted", `─ ${title} `);
    const headerPad = Math.max(0, usable - visibleWidth(headerLeft));
    const lines = [
      truncateToWidth(`${headerLeft}${theme.fg("border", "─".repeat(headerPad))}`, usable, ""),
    ];
    for (const [index, item] of this.#queue.items.entries()) {
      const selected = index === this.#queue.selectedIndex;
      const editing = this.#queue.editingId === item.id;
      const marker = editing
        ? theme.fg("primary", "› ")
        : selected
          ? theme.fg("primary", "○ ")
          : theme.fg("textDim", "○ ");
      const body = item.text.replaceAll(/\s+/g, " ").trim();
      const prefixWidth = visibleWidth(marker);
      const text = truncateToWidth(body, Math.max(8, usable - prefixWidth - 1), "…");
      const row = editing || selected
        ? theme.fg(editing ? "primary" : "text", `${marker}${text}`)
        : theme.fg("textDim", `${marker}${text}`);
      lines.push(truncateToWidth(row, usable, ""));
      lines.push("");
    }
    lines.push(truncateToWidth(theme.fg("textDim", ` ${hint}`), usable, ""));
    lines.push(rule);
    return lines;
  }
}
