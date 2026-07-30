export interface ClipboardBinding {
  hasImage(): boolean;
  getImageBinary(): Promise<number[]>;
  getText?(): Promise<string>;
}

export type ClipboardPaste =
  | { readonly type: "image"; readonly bytes: Uint8Array }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "empty" };

/** Rich-TTY clipboard read. Native loading is optional and failures degrade to ordinary terminal paste. */
export async function readClipboardPaste(
  bindingOverride?: ClipboardBinding | null,
): Promise<ClipboardPaste> {
  let binding: ClipboardBinding;
  if (bindingOverride === null) return { type: "empty" };
  if (bindingOverride !== undefined) {
    binding = bindingOverride;
  } else {
    try {
      const loaded = await import("@mariozechner/clipboard") as unknown as
        ClipboardBinding & { default?: ClipboardBinding; clipboard?: ClipboardBinding };
      binding = loaded.clipboard ?? loaded.default ?? loaded;
    } catch {
      return { type: "empty" };
    }
  }
  try {
    if (binding.hasImage()) {
      const bytes = Uint8Array.from(await binding.getImageBinary());
      if (bytes.byteLength > 0) return { type: "image", bytes };
    }
  } catch {
    // Fall through to text.
  }
  try {
    const text = await binding.getText?.();
    return text ? { type: "text", text } : { type: "empty" };
  } catch {
    return { type: "empty" };
  }
}
