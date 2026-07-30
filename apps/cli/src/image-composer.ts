import type { RunImagePart, RunInputPart } from "@civaapple/qi-protocol";

export function imagePlaceholder(number: number, image: RunImagePart): string {
  return `[image #${number} (${image.width}×${image.height})]`;
}

/**
 * Convert only intact, known placeholders into image parts. Deleted, edited, duplicated, or unknown
 * placeholders remain ordinary text and cannot smuggle an attachment into submission.
 */
export function structuredComposerContent(
  raw: string,
  images: ReadonlyMap<string, RunImagePart>,
): readonly RunInputPart[] | undefined {
  if (images.size === 0) return undefined;
  const content: RunInputPart[] = [];
  const used = new Set<string>();
  const pattern = /\[image #\d+ \(\d+×\d+\)\]/g;
  let cursor = 0;
  for (const match of raw.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const image = images.get(match[0]);
    if (image === undefined || used.has(match[0])) continue;
    const text = raw.slice(cursor, match.index);
    if (text) content.push({ type: "text", text });
    content.push({ ...image });
    used.add(match[0]);
    cursor = match.index + match[0].length;
  }
  const tail = raw.slice(cursor);
  if (tail) content.push({ type: "text", text: tail });
  return content.some((part) => part.type === "image") ? content : undefined;
}
