import type { Effect } from "@civaapple/qi-agent/capability";
import {
  panelFooter,
  panelHeader,
  pointer,
  theme,
  type PanelComponent,
} from "@civaapple/qi-tui";
import { Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";

export type McpDraftEffect = Effect | "unbound";

export interface McpBindingPanelAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface McpBindingPanelCandidate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly effects: readonly Effect[];
  readonly currentEffect?: Effect;
  readonly state: "unbound" | "bound" | "drifted";
}

export interface McpBindingPanelChange {
  readonly id: string;
  readonly effect: McpDraftEffect;
}

export interface McpBindingPanelOptions {
  readonly title: string;
  readonly locale: "zh" | "en";
  readonly actions?: readonly McpBindingPanelAction[];
  readonly candidates: readonly McpBindingPanelCandidate[];
  readonly maxVisible?: number;
  readonly onAction: (id: string) => void;
  readonly onApply: (changes: readonly McpBindingPanelChange[]) => void;
  readonly onClose: () => void;
}

type McpBindingPanelEntry =
  | { readonly type: "action"; readonly value: McpBindingPanelAction }
  | { readonly type: "candidate"; readonly value: McpBindingPanelCandidate };

/** MCP-specific batch review: arrows classify exact capabilities and Enter commits all pending changes. */
export class McpBindingPanel implements PanelComponent, Focusable {
  readonly title: string;
  focused = false;
  readonly #locale: "zh" | "en";
  readonly #entries: readonly McpBindingPanelEntry[];
  readonly #candidates: ReadonlyMap<string, McpBindingPanelCandidate>;
  readonly #maxVisible: number;
  readonly #onAction: (id: string) => void;
  readonly #onApply: (changes: readonly McpBindingPanelChange[]) => void;
  readonly #onClose: () => void;
  readonly #search = new Input();
  readonly #drafts = new Map<string, McpDraftEffect>();
  #filtered: McpBindingPanelEntry[];
  #cursor: number;
  #query = "";

  constructor(options: McpBindingPanelOptions) {
    this.title = options.title;
    this.#locale = options.locale;
    const actions = (options.actions ?? []).map((value) => ({ type: "action" as const, value }));
    const candidates = options.candidates.map((value) => ({ type: "candidate" as const, value }));
    this.#entries = [...actions, ...candidates];
    this.#filtered = [...this.#entries];
    this.#candidates = new Map(options.candidates.map((candidate) => [candidate.id, candidate]));
    this.#cursor = candidates.length > 0 ? actions.length : 0;
    this.#maxVisible = Math.max(5, options.maxVisible ?? 7);
    this.#onAction = options.onAction;
    this.#onApply = options.onApply;
    this.#onClose = options.onClose;
    for (const candidate of options.candidates) {
      this.#drafts.set(candidate.id, candidate.currentEffect ?? "unbound");
    }
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
    if (matchesKey(data, Key.up)) {
      this.#cursor = Math.max(0, this.#cursor - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#cursor = Math.min(Math.max(0, this.#filtered.length - 1), this.#cursor + 1);
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const entry = this.#filtered[this.#cursor];
      if (entry?.type !== "candidate") return;
      const choices: readonly McpDraftEffect[] = ["unbound", ...entry.value.effects];
      const current = this.#drafts.get(entry.value.id) ?? "unbound";
      const currentIndex = Math.max(0, choices.indexOf(current));
      const direction = matchesKey(data, Key.right) ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(choices.length - 1, currentIndex + direction));
      this.#drafts.set(entry.value.id, choices[nextIndex]!);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = this.#filtered[this.#cursor];
      if (entry?.type === "action") {
        this.#onAction(entry.value.id);
        return;
      }
      this.#onApply(this.#changes());
      return;
    }
    this.#search.handleInput(data);
    this.#query = this.#search.getValue();
    this.#applyFilter();
  }

  render(width: number): string[] {
    const safe = Math.max(20, width);
    const hints = this.#locale === "zh"
      ? "↑↓ 选择 · ←→ 效果 · Enter 保存 · Esc 放弃 · type to search"
      : "↑↓ navigate · ←→ effect · Enter save · Esc cancel · type to search";
    const lines = [...panelHeader(this.title, hints, safe), ""];
    if (this.#query) {
      lines.push(truncateToWidth(theme.fg("textDim", ` filter: ${this.#query}`), safe, "…"), "");
    }
    if (this.#filtered.length === 0) {
      lines.push(theme.fg("textMuted", this.#locale === "zh" ? "  没有匹配项。" : "  No matches."), "", ...panelFooter(safe));
      return lines;
    }
    const start = Math.max(
      0,
      Math.min(this.#cursor - Math.floor(this.#maxVisible / 2), this.#filtered.length - this.#maxVisible),
    );
    const end = Math.min(start + this.#maxVisible, this.#filtered.length);
    for (let index = start; index < end; index += 1) {
      const entry = this.#filtered[index]!;
      const selected = index === this.#cursor;
      const label = selected ? theme.bold(entry.value.label) : entry.value.label;
      lines.push(truncateToWidth(`${pointer(selected)}${label}`, safe, "…"));
      if (entry.type === "action") {
        lines.push(truncateToWidth(theme.fg("textDim", `    ${entry.value.description}`), safe, "…"));
        continue;
      }
      const draft = this.#drafts.get(entry.value.id) ?? "unbound";
      const baseline = entry.value.currentEffect ?? "unbound";
      const changed = draft !== baseline;
      const marker = changed
        ? (this.#locale === "zh" ? "待保存" : "pending")
        : entry.value.state === "drifted"
          ? (this.#locale === "zh" ? "待重审" : "re-review")
          : (this.#locale === "zh" ? "当前" : "current");
      const prior = changed
        ? ` · ${this.#locale === "zh" ? "原" : "was"} ${effectLabel(baseline, this.#locale)}`
        : "";
      const description = `${effectLabel(draft, this.#locale)} ← ${marker}${prior} · ${entry.value.description}`;
      lines.push(truncateToWidth(theme.fg("textDim", `    ${description}`), safe, "…"));
    }
    const dirty = this.#changes().length;
    const info = this.#locale === "zh"
      ? `${dirty} 项待保存 · ${this.#cursor + 1}/${this.#filtered.length}`
      : `${dirty} pending · ${this.#cursor + 1}/${this.#filtered.length}`;
    lines.push("", ...panelFooter(safe, info));
    return lines;
  }

  #changes(): McpBindingPanelChange[] {
    const changes: McpBindingPanelChange[] = [];
    for (const candidate of this.#candidates.values()) {
      const draft = this.#drafts.get(candidate.id) ?? "unbound";
      const baseline = candidate.currentEffect ?? "unbound";
      if (draft !== baseline || candidate.state === "drifted") changes.push({ id: candidate.id, effect: draft });
    }
    return changes;
  }

  #applyFilter(): void {
    const needle = this.#query.trim().toLowerCase();
    this.#filtered = needle
      ? this.#entries.filter((entry) => {
        const effect = entry.type === "candidate" ? this.#drafts.get(entry.value.id) ?? "unbound" : "";
        return `${entry.value.label} ${entry.value.description} ${effect}`.toLowerCase().includes(needle);
      })
      : [...this.#entries];
    this.#cursor = Math.min(this.#cursor, Math.max(0, this.#filtered.length - 1));
  }
}

function effectLabel(effect: McpDraftEffect, locale: "zh" | "en"): string {
  if (effect === "unbound") return locale === "zh" ? "隔离" : "quarantined";
  return effect;
}
