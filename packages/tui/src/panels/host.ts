import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import type { PanelComponent } from "./types.js";

/**
 * Replaces the editor region with a temporary panel stack.
 * Esc / close pops one level; empty stack restores the editor.
 */
export class PanelHost {
  readonly #tui: TUI;
  readonly #container: Container;
  readonly #editor: Component & Focusable;
  readonly #stack: PanelComponent[] = [];
  readonly #onChange: () => void;

  constructor(
    tui: TUI,
    container: Container,
    editor: Component & Focusable,
    onChange: () => void,
  ) {
    this.#tui = tui;
    this.#container = container;
    this.#editor = editor;
    this.#onChange = onChange;
  }

  get open(): boolean {
    return this.#stack.length > 0;
  }

  get depth(): number {
    return this.#stack.length;
  }

  push(panel: PanelComponent): void {
    this.#stack.push(panel);
    this.#mountTop();
    this.#onChange();
  }

  pop(): void {
    this.#stack.pop();
    this.#mountTop();
    this.#onChange();
  }

  closeAll(): void {
    this.#stack.length = 0;
    this.#mountTop();
    this.#onChange();
  }

  /** Close helper bound into panel factories. */
  dismiss = (): void => {
    this.pop();
  };

  /**
   * Deliver a key to the top panel and consume it at the TUI listener.
   * Used for Esc so dismiss cannot race with Editor focus / Run cancel.
   */
  deliverInput(data: string): void {
    const top = this.#stack.at(-1);
    if (!top?.handleInput) return;
    top.handleInput(data);
    this.#onChange();
  }

  #mountTop(): void {
    this.#container.clear();
    const top = this.#stack.at(-1);
    if (top) {
      this.#container.addChild(top);
      this.#tui.setFocus(top);
      return;
    }
    this.#container.addChild(this.#editor);
    this.#tui.setFocus(this.#editor);
  }
}
