import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { sniffImageMediaType } from "@civaapple/qi-node/media";

export interface ClipboardBinding {
  hasImage(): boolean;
  getImageBinary(): Promise<number[]>;
  getText?(): Promise<string>;
}

export type ClipboardPaste =
  | { readonly type: "image"; readonly bytes: Uint8Array }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "empty" };

const imagePathPattern = /\.(?:png|jpe?g|gif|webp)$/i;

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
    // Fall through to text / file-path clipboard.
  }
  try {
    const text = await binding.getText?.();
    if (!text) return { type: "empty" };
    const fromPath = await tryReadClipboardImagePath(text);
    if (fromPath) return { type: "image", bytes: fromPath };
    return { type: "text", text };
  } catch {
    return { type: "empty" };
  }
}

/**
 * When Explorer/Finder copies a file (or a file:// URI list), read one absolute image path.
 * Relative clipboard text stays ordinary paste so it cannot smuggle Workspace reads.
 */
export async function tryReadClipboardImagePath(text: string): Promise<Uint8Array | undefined> {
  for (const line of splitClipboardPathLines(text)) {
    const absolute = normalizeClipboardPath(line);
    if (!absolute || !isAbsolute(absolute) || !imagePathPattern.test(absolute)) continue;
    try {
      const bytes = new Uint8Array(await readFile(absolute));
      if (bytes.byteLength > 0 && sniffImageMediaType(bytes) !== undefined) return bytes;
    } catch {
      // Try the next clipboard path line.
    }
  }
  return undefined;
}

function splitClipboardPathLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function normalizeClipboardPath(line: string): string {
  if (line.startsWith("file://")) {
    try {
      return fileURLToPath(line);
    } catch {
      return "";
    }
  }
  return line.replace(/^['"]|['"]$/g, "");
}
