import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import type { SessionId } from "@civaapple/qi-protocol";
import { theme } from "../theme/index.js";
import {
  formatRelativeTime,
  shortSessionId,
  type SessionEntry,
} from "../session-list.js";
import { panelFooter, panelHeader, pointer } from "./chrome.js";
import type { PanelComponent } from "./types.js";

export const NEW_SESSION_ID = "__new__";

export interface SessionsPanelItem {
  readonly id: string;
  readonly title: string;
  readonly sessionId?: SessionId;
  readonly updatedAt?: string;
  readonly workspaceRoot?: string;
  readonly preview?: string;
  readonly current?: boolean;
  readonly isNew?: boolean;
  readonly location?: "active" | "archived";
}

export interface SessionsPanelOptions {
  readonly title: string;
  readonly hints: string;
  readonly emptyLabel: string;
  readonly currentMark: string;
  readonly showingLabel: (visibleFrom: number, visibleTo: number, total: number) => string;
  readonly items: readonly SessionsPanelItem[];
  readonly initialSelected?: number;
  readonly maxVisible?: number;
  readonly onSelect: (item: SessionsPanelItem) => void;
  readonly onArchive?: (item: SessionsPanelItem) => void;
  readonly onClose: () => void;
}

/** Multi-line searchable Session list: title/age, id/workspace, preview. */
export class SessionsPanel implements PanelComponent, Focusable {
  readonly title: string;
  focused = false;
  readonly #all: readonly SessionsPanelItem[];
  readonly #hints: string;
  readonly #emptyLabel: string;
  readonly #currentMark: string;
  readonly #showingLabel: SessionsPanelOptions["showingLabel"];
  readonly #maxVisible: number;
  readonly #onSelect: (item: SessionsPanelItem) => void;
  readonly #onArchive: ((item: SessionsPanelItem) => void) | undefined;
  readonly #onClose: () => void;
  readonly #search: Input;
  #filtered: SessionsPanelItem[];
  #selected = 0;
  #query = "";
  #location: "active" | "archived" = "active";

  constructor(options: SessionsPanelOptions) {
    this.title = options.title;
    this.#all = options.items;
    this.#filtered = options.items.filter((item) => item.location !== "archived");
    this.#hints = options.hints;
    this.#emptyLabel = options.emptyLabel;
    this.#currentMark = options.currentMark;
    this.#showingLabel = options.showingLabel;
    this.#maxVisible = Math.max(3, options.maxVisible ?? 8);
    this.#onSelect = options.onSelect;
    this.#onArchive = options.onArchive;
    this.#onClose = options.onClose;
    this.#search = new Input();
    this.#search.focused = false;
    if (options.initialSelected !== undefined && this.#filtered.length > 0) {
      this.#selected = Math.max(0, Math.min(options.initialSelected, this.#filtered.length - 1));
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
      if (item) this.#onSelect(item);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.#location = this.#location === "active" ? "archived" : "active";
      this.#query = "";
      this.#search.setValue("");
      this.#selected = 0;
      this.#applyFilter();
      return;
    }
    // Archive shortcut only when the filter is empty so typing "a" into search still works.
    if (data === "a" && !this.#query && this.#location === "active") {
      const item = this.#filtered[this.#selected];
      if (item && !item.isNew && item.location !== "archived") this.#onArchive?.(item);
      return;
    }
    this.#search.handleInput(data);
    this.#query = this.#search.getValue();
    this.#applyFilter();
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const viewTitle = `${this.title} · ${this.#location === "active" ? "Active" : "Archived"}`;
    const lines = [...panelHeader(viewTitle, this.#hints, safe), ""];
    if (this.#query) {
      lines.push(truncateToWidth(theme.fg("textDim", ` filter: ${this.#query}`), safe, "…"), "");
    }
    if (this.#filtered.length === 0) {
      lines.push(theme.fg("textMuted", `  ${this.#emptyLabel}`), "", ...panelFooter(safe));
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
      lines.push(...this.#renderItem(item, selected, safe));
      if (index < end - 1) lines.push("");
    }
    const info = this.#showingLabel(start + 1, end, this.#filtered.length);
    lines.push("", ...panelFooter(safe, info));
    return lines;
  }

  #renderItem(item: SessionsPanelItem, selected: boolean, width: number): string[] {
    const age = item.updatedAt ? `  ${formatRelativeTime(item.updatedAt)}` : "";
    const mark = item.current
      ? theme.fg("primary", ` ${this.#currentMark}`)
      : item.location === "archived"
        ? theme.fg("textMuted", " [Archived]")
        : "";
    const title = selected ? theme.bold(item.title) : item.title;
    const titleLine = truncateToWidth(
      `${pointer(selected)}${title}${theme.fg("textDim", age)}${mark}`,
      width,
      "…",
    );
    if (item.isNew) return [titleLine];

    const id = shortSessionId(item.sessionId ?? item.id);
    const workspace = item.workspaceRoot ?? "";
    const meta = truncateToWidth(
      theme.fg("textDim", `  ${id}   ${workspace}`),
      width,
      "…",
    );
    const previewRaw = item.preview?.trim() ? `› ${item.preview.trim()}` : "›";
    const preview = truncateToWidth(
      theme.fg("textMuted", `  ${previewRaw}`),
      width,
      "…",
    );
    return [titleLine, meta, preview];
  }

  #applyFilter(): void {
    const needle = this.#query.trim().toLowerCase();
    const located = this.#all.filter((item) =>
      this.#location === "active"
        ? item.location !== "archived"
        : item.location === "archived");
    this.#filtered = needle
      ? located.filter((item) => matchesSessionItem(item, needle))
      : located;
    this.#selected = Math.min(this.#selected, Math.max(0, this.#filtered.length - 1));
  }
}

export function sessionEntriesToPanelItems(
  entries: readonly SessionEntry[],
  currentSessionId: string,
  newSessionLabel: string,
): SessionsPanelItem[] {
  return [
    { id: NEW_SESSION_ID, title: newSessionLabel, isNew: true },
    ...entries.map((entry) => ({
      id: entry.sessionId,
      title: entry.title,
      sessionId: entry.sessionId,
      updatedAt: entry.updatedAt,
      workspaceRoot: entry.workspaceRoot,
      preview: entry.preview,
      current: entry.sessionId === currentSessionId,
      location: entry.location,
    })),
  ];
}

function matchesSessionItem(item: SessionsPanelItem, needle: string): boolean {
  if (item.isNew) return item.title.toLowerCase().includes(needle);
  return (
    item.title.toLowerCase().includes(needle)
    || (item.sessionId?.toLowerCase().includes(needle) ?? false)
    || item.id.toLowerCase().includes(needle)
    || (item.preview?.toLowerCase().includes(needle) ?? false)
    || (item.workspaceRoot?.toLowerCase().includes(needle) ?? false)
  );
}
