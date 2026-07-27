/** UI-only follow-up queue (Cursor-style). Not Session truth until drained into a Run. */

export interface FollowUpItem {
  readonly id: string;
  readonly text: string;
}

export class FollowUpQueue {
  #items: FollowUpItem[] = [];
  #selectedIndex = -1;
  #editingId: string | undefined;
  #nextId = 1;
  /** Text restored when canceling an edit. */
  #editSnapshot: string | undefined;

  get items(): readonly FollowUpItem[] {
    return this.#items;
  }

  get length(): number {
    return this.#items.length;
  }

  get selectedIndex(): number {
    return this.#selectedIndex;
  }

  get editingId(): string | undefined {
    return this.#editingId;
  }

  get editing(): boolean {
    return this.#editingId !== undefined;
  }

  get selected(): FollowUpItem | undefined {
    if (this.#selectedIndex < 0 || this.#selectedIndex >= this.#items.length) return undefined;
    return this.#items[this.#selectedIndex];
  }

  enqueue(text: string): FollowUpItem {
    const trimmed = text.trim();
    if (!trimmed) throw new TypeError("follow-up text is required");
    const item: FollowUpItem = { id: `fu-${this.#nextId++}`, text: trimmed };
    this.#items = [...this.#items, item];
    return item;
  }

  removeSelected(): FollowUpItem | undefined {
    if (this.#selectedIndex < 0 || this.#selectedIndex >= this.#items.length) return undefined;
    const [removed] = this.#items.splice(this.#selectedIndex, 1);
    this.#items = [...this.#items];
    if (removed && this.#editingId === removed.id) this.#clearEdit();
    if (this.#items.length === 0) {
      this.#selectedIndex = -1;
    } else if (this.#selectedIndex >= this.#items.length) {
      this.#selectedIndex = this.#items.length - 1;
    }
    return removed;
  }

  /** Promote selected item to the front of the queue (send now / next). */
  moveSelectedToFront(): FollowUpItem | undefined {
    const selected = this.selected;
    if (!selected) return undefined;
    this.#items = [selected, ...this.#items.filter((item) => item.id !== selected.id)];
    this.#selectedIndex = 0;
    return selected;
  }

  dequeue(): FollowUpItem | undefined {
    if (this.#items.length === 0) return undefined;
    const [first, ...rest] = this.#items;
    this.#items = rest;
    if (first && this.#editingId === first.id) this.#clearEdit();
    if (this.#selectedIndex >= this.#items.length) {
      this.#selectedIndex = this.#items.length === 0 ? -1 : this.#items.length - 1;
    } else if (this.#selectedIndex > 0) {
      this.#selectedIndex -= 1;
    }
    return first;
  }

  selectLast(): FollowUpItem | undefined {
    if (this.#items.length === 0) {
      this.#selectedIndex = -1;
      return undefined;
    }
    this.#selectedIndex = this.#items.length - 1;
    return this.selected;
  }

  selectPrev(): FollowUpItem | undefined {
    if (this.#items.length === 0) return undefined;
    if (this.#selectedIndex < 0) {
      this.#selectedIndex = this.#items.length - 1;
    } else if (this.#selectedIndex > 0) {
      this.#selectedIndex -= 1;
    }
    return this.selected;
  }

  selectNext(): FollowUpItem | undefined {
    if (this.#items.length === 0) return undefined;
    if (this.#selectedIndex < 0) {
      this.#selectedIndex = 0;
    } else if (this.#selectedIndex < this.#items.length - 1) {
      this.#selectedIndex += 1;
    }
    return this.selected;
  }

  clearSelection(): void {
    if (this.#editingId) this.#clearEdit();
    this.#selectedIndex = -1;
  }

  /** Start editing the selected (or last) item; returns text to load into the composer. */
  beginEdit(index = this.#selectedIndex): string | undefined {
    if (this.#items.length === 0) return undefined;
    const target = index < 0 ? this.#items.length - 1 : index;
    if (target < 0 || target >= this.#items.length) return undefined;
    this.#selectedIndex = target;
    const item = this.#items[target]!;
    this.#editingId = item.id;
    this.#editSnapshot = item.text;
    return item.text;
  }

  commitEdit(text: string): FollowUpItem | undefined {
    if (!this.#editingId) return undefined;
    const trimmed = text.trim();
    if (!trimmed) {
      // Empty commit cancels the item.
      const index = this.#items.findIndex((item) => item.id === this.#editingId);
      this.#clearEdit();
      if (index >= 0) {
        this.#selectedIndex = index;
        return this.removeSelected();
      }
      return undefined;
    }
    const index = this.#items.findIndex((item) => item.id === this.#editingId);
    if (index < 0) {
      this.#clearEdit();
      return undefined;
    }
    const updated: FollowUpItem = { id: this.#editingId, text: trimmed };
    this.#items = this.#items.map((item, i) => (i === index ? updated : item));
    this.#clearEdit();
    this.#selectedIndex = index;
    return updated;
  }

  /** Discard composer edits and restore the item text. */
  cancelEdit(): string | undefined {
    if (!this.#editingId) return undefined;
    const snapshot = this.#editSnapshot;
    this.#clearEdit();
    return snapshot;
  }

  #clearEdit(): void {
    this.#editingId = undefined;
    this.#editSnapshot = undefined;
  }
}
