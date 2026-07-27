import type { Component, Editor, Focusable } from "@earendil-works/pi-tui";
import { padToDisplayWidth, splitKeepRight, truncateToWidth, visibleWidth } from "./layout.js";
import { theme } from "./theme/index.js";

export interface ComposerPlaceholder {
  readonly left: string;
  readonly right: string;
}

/**
 * Editor shell: empty state matches Cursor (hint + ctrl+c inside the border).
 * A static reverse-video caret marks the first letter of the prompt (e.g. A in Add);
 * the terminal hardware caret stays hidden so it does not blink as a second bar.
 * While typing, delegates to pi-tui Editor (IME still gets CURSOR_MARKER positioning).
 */
export class ComposerComponent implements Component, Focusable {
  focused = false;
  readonly #editor: Editor;
  readonly #placeholder: () => ComposerPlaceholder | undefined;

  constructor(editor: Editor, placeholder: () => ComposerPlaceholder | undefined) {
    this.#editor = editor;
    this.#placeholder = placeholder;
  }

  invalidate(): void {
    this.#editor.invalidate();
  }

  render(width: number): string[] {
    const hint = this.#editor.getText().length === 0 ? this.#placeholder() : undefined;
    if (hint) {
      // Keep Editor unfocused for paint so it does not emit a second caret/marker.
      this.#editor.focused = false;
      return renderComposerPlaceholder(width, hint);
    }
    this.#editor.focused = this.focused;
    return this.#editor.render(width);
  }

  handleInput(data: string): void {
    this.#editor.handleInput(data);
  }
}

export function renderComposerPlaceholder(width: number, hint: ComposerPlaceholder): string[] {
  const usable = Math.max(20, width);
  const horizontal = theme.fg("border", "─".repeat(usable));
  const inner = Math.max(8, usable - 2);
  const leftPainted = paintPromptWithCaret(hint.left);
  const rightPainted = hint.right ? theme.fg("textDim", hint.right) : "";
  const body = rightPainted
    ? splitKeepRight(leftPainted, rightPainted, inner)
    : leftPainted || paintStaticCaret();
  const line = padToDisplayWidth(truncateToWidth(` ${body} `, usable, ""), usable);
  if (visibleWidth(line) === 0) {
    return [horizontal, padToDisplayWidth(` ${paintStaticCaret()}`, usable), horizontal];
  }
  return [horizontal, line, horizontal];
}

/** Reverse-video block used as a non-blinking “start typing here” marker. */
function paintStaticCaret(): string {
  return "\x1b[7m \x1b[0m";
}

/**
 * Paint `→ Add a …` with a white/inverse bar on the first letter after the arrow
 * (the A in Add), so the empty composer shows where input begins.
 */
export function paintPromptWithCaret(left: string): string {
  const trimmed = left.trimStart();
  if (!trimmed) return paintStaticCaret();
  const arrow = /^(→\s*)(.*)$/u.exec(trimmed);
  if (arrow) {
    const prefix = arrow[1] ?? "→ ";
    const rest = arrow[2] ?? "";
    if (!rest) return `${theme.fg("textDim", prefix)}${paintStaticCaret()}`;
    const chars = [...rest];
    const first = chars[0] ?? "";
    const after = chars.slice(1).join("");
    return `${theme.fg("textDim", prefix)}\x1b[7m${first}\x1b[0m${theme.fg("textDim", after)}`;
  }
  const chars = [...trimmed];
  const first = chars[0] ?? "";
  const after = chars.slice(1).join("");
  return `\x1b[7m${first}\x1b[0m${theme.fg("textDim", after)}`;
}
