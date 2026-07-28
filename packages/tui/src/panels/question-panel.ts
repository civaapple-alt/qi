import { Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { panelFooter, panelHeader, pointer } from "./chrome.js";
import type { PanelComponent } from "./types.js";

export interface QuestionPanelQuestion {
  readonly id: string;
  readonly header: string;
  readonly prompt: string;
  readonly selection: "single" | "multiple" | "text";
  readonly options: readonly { id: string; label: string; description?: string }[];
  readonly allowText: boolean;
}

export interface QuestionPanelAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly text?: string;
  readonly skipped: boolean;
}

export class QuestionPanel implements PanelComponent, Focusable {
  readonly title = "Question";
  focused = false;
  readonly #questions: readonly QuestionPanelQuestion[];
  readonly #onSubmit: (answers: readonly QuestionPanelAnswer[]) => void;
  readonly #answers: QuestionPanelAnswer[] = [];
  readonly #selected = new Set<string>();
  #questionIndex = 0;
  #cursor = 0;
  #editingText = false;
  #text = "";

  constructor(options: {
    questions: readonly QuestionPanelQuestion[];
    onSubmit: (answers: readonly QuestionPanelAnswer[]) => void;
  }) {
    this.#questions = options.questions;
    this.#onSubmit = options.onSubmit;
    this.#editingText = options.questions[0]?.selection === "text";
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const question = this.#questions[this.#questionIndex];
    if (!question) return;
    if (matchesKey(data, Key.escape)) {
      this.#finish({ questionId: question.id, selectedOptionIds: [], skipped: true });
      return;
    }
    if (this.#editingText) {
      if (matchesKey(data, Key.enter)) {
        if (this.#text.trim()) {
          this.#finish({
            questionId: question.id,
            selectedOptionIds: [...this.#selected],
            text: this.#text.trim(),
            skipped: false,
          });
        }
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.#text = [...this.#text].slice(0, -1).join("");
        return;
      }
      if (!data.includes("\u001b") && !matchesKey(data, "ctrl+c")) this.#text += data;
      return;
    }
    const itemCount = question.options.length + (question.allowText ? 1 : 0);
    if (matchesKey(data, Key.up)) {
      this.#cursor = Math.max(0, this.#cursor - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#cursor = Math.min(Math.max(0, itemCount - 1), this.#cursor + 1);
      return;
    }
    const custom = question.allowText && this.#cursor === question.options.length;
    if (matchesKey(data, Key.space) && question.selection === "multiple" && !custom) {
      const option = question.options[this.#cursor];
      if (!option) return;
      if (this.#selected.has(option.id)) this.#selected.delete(option.id);
      else this.#selected.add(option.id);
      return;
    }
    if (!matchesKey(data, Key.enter)) return;
    if (custom) {
      this.#editingText = true;
      return;
    }
    const option = question.options[this.#cursor];
    if (question.selection === "single" && option) {
      this.#finish({
        questionId: question.id,
        selectedOptionIds: [option.id],
        skipped: false,
      });
      return;
    }
    if (question.selection === "multiple" && this.#selected.size > 0) {
      this.#finish({
        questionId: question.id,
        selectedOptionIds: [...this.#selected],
        skipped: false,
      });
    }
  }

  render(width: number): string[] {
    const safe = Math.max(24, width);
    const question = this.#questions[this.#questionIndex];
    if (!question) return [];
    const progress = `${this.#questionIndex + 1}/${this.#questions.length}`;
    const hints = this.#editingText
      ? `type · Enter confirm · Esc skip · ${progress}`
      : `${question.selection === "multiple" ? "Space toggle · " : ""}Enter confirm · Esc skip · ${progress}`;
    const lines = [...panelHeader(`${question.header}`, hints, safe), ""];
    lines.push(...wrapPlain(question.prompt, safe - 2).map((line) => `  ${line}`), "");
    if (this.#editingText) {
      lines.push(truncateToWidth(theme.fg("accent", `  > ${this.#text}▌`), safe, "…"));
    } else {
      question.options.forEach((option, index) => {
        const focused = index === this.#cursor;
        const mark = question.selection === "multiple"
          ? (this.#selected.has(option.id) ? "[x] " : "[ ] ")
          : "";
        lines.push(truncateToWidth(`${pointer(focused)}${focused ? theme.bold(mark + option.label) : mark + option.label}`, safe, "…"));
        if (option.description) {
          lines.push(truncateToWidth(theme.fg("textDim", `    ${option.description}`), safe, "…"));
        }
      });
      if (question.allowText) {
        const focused = this.#cursor === question.options.length;
        lines.push(truncateToWidth(`${pointer(focused)}${focused ? theme.bold("Other…") : "Other…"}`, safe, "…"));
      }
    }
    lines.push("", ...panelFooter(safe, "Ctrl+C cancels this Run"));
    return lines;
  }

  #finish(answer: QuestionPanelAnswer): void {
    this.#answers.push(answer);
    this.#questionIndex += 1;
    this.#cursor = 0;
    this.#selected.clear();
    this.#text = "";
    const next = this.#questions[this.#questionIndex];
    this.#editingText = next?.selection === "text";
    if (!next) this.#onSubmit([...this.#answers]);
  }
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
