const markdownImagePattern = /!\[[^\]\r\n]*\]\(\s*(https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gi;
const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
const imageExtensionPattern = /\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i;

export interface ImageUrlCandidate {
  readonly url: string;
  readonly start: number;
  readonly end: number;
  readonly explicit: boolean;
}

/**
 * Extract explicit Markdown images, standalone URLs, and embedded URLs with a known image extension.
 * HTTP MIME and magic-byte checks remain authoritative during ingestion.
 */
export function detectImageUrlCandidates(input: string): ImageUrlCandidate[] {
  const candidates = new Map<string, ImageUrlCandidate>();
  for (const match of input.matchAll(markdownImagePattern)) {
    const url = match[1];
    if (!url || match.index === undefined) continue;
    const relative = match[0].indexOf(url);
    const start = match.index + relative;
    candidates.set(`${start}:${url}`, { url, start, end: start + url.length, explicit: true });
  }
  for (const match of input.matchAll(urlPattern)) {
    const url = match[0].replace(/[.,;:!?]+$/g, "");
    if (match.index === undefined) continue;
    const lineStart = input.lastIndexOf("\n", match.index - 1) + 1;
    const nextLineBreak = input.indexOf("\n", match.index + match[0].length);
    const lineEnd = nextLineBreak < 0 ? input.length : nextLineBreak;
    const standalone = input.slice(lineStart, lineEnd).trim() === url;
    if (!standalone && !imageExtensionPattern.test(url)) continue;
    const key = `${match.index}:${url}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        url,
        start: match.index,
        end: match.index + url.length,
        explicit: imageExtensionPattern.test(url) || standalone,
      });
    }
  }
  return [...candidates.values()].sort((left, right) => left.start - right.start);
}
